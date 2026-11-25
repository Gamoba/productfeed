// FeedFlow's MCP server: the tools Claude (or another MCP client) can call.
//
// One server per request (the endpoint is stateless), built for the signed-in
// user. Every tool starts from that user and goes through getOwnedFeed /
// getOwnedProject, the same access checks as the UI, so the assistant reaches
// exactly the agency's shops the person can open.
//
// Reads answer straight away. Writes never change anything directly: they
// become proposed changes (lib/mcp/changes), applied at once only when the
// agency has turned on "apply without approval". Shopify is never written to —
// the only Shopify traffic here is the read-only product sync.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { adminDb, getOwnedFeed, getOwnedProject, type OwnedFeed } from '@/lib/feeds'
import { getAgencyOverview } from '@/lib/agencyOverview'
import { getMemberships } from '@/lib/accounts'
import { channelOf } from '@/lib/channels'
import { countryName } from '@/lib/formatDa'
import { feedView, countFilteredProducts } from '@/lib/feedGenerator'
import { toShopifyData, syncProducts, type SupabaseProduct } from '@/lib/sync'
import { describeMapping, getShopActivity, logActivity } from '@/lib/activity'
import { describeRule, isActiveRule, type FeedFilterRule } from '@/lib/feedFilters'
import { getFeedMetafields } from '@/lib/optimizationBuckets'
import { getShopPerformance } from '@/lib/shopPerformance'
import { AUTO_SYNC_FREQUENCIES } from '@/lib/syncSchedule'
import { enforceRateLimit } from '@/lib/rateLimit'
import { AppError, clientMessage } from '@/lib/errors'
import { formatNumber } from '@/lib/formatDa'
import { ADVANCED_CATEGORIES, COLLAPSIBLE_SECTIONS, REQUIRED_FIELDS, STANDARD_FIELDS } from '@/lib/mappingFields'
import { extractWarnings, scheduleLabel, type FilterConfig, type MappingEntry } from '@/lib/ops/feedConfig'
import { clientName, listChanges, proposeChange, type ChangeDetail, type ProposeResult } from '@/lib/mcp/changes'
import type { McpCaller } from '@/lib/mcp/auth'
import {
  BUCKET_METRICS,
  BUCKET_OPERATORS,
  listBuckets as listLabelBuckets,
  listLabels,
  recomputeFeed,
  recomputeLabel,
  type BucketRule,
} from '@/lib/googleAdsBuckets'
import * as titleBuckets from '@/lib/optimizationBuckets'
import * as titleSvc from '@/lib/titleOptimizationService'
import * as titleWorkshop from '@/lib/bucketExamples'
import { MAX_RUN_PRODUCTS } from '@/lib/ops/titles'

const INSTRUCTIONS = `FeedFlow builds product feeds (Google Shopping and other channels) from an agency's shops.
Hierarchy: agency → shop → feed (one channel + country). Start with list_shops to get shop and feed ids.
Reads are free. Every change (set_mapping, set_rules, set_feed_settings) is a proposal: it is applied at once only if the agency allows changes without approval; otherwise it waits for a person to approve it in FeedFlow under Shop › API / MCP. Always tell the user which it was.
FeedFlow never writes to Shopify. Product data comes from Shopify (read-only); FeedFlow decides how it is mapped and filtered into the feed.
Before changing a mapping, read get_mapping and check the result on real products with search_products.
Labels: custom labels (custom_label_0–4) computed from Google Ads performance. Read get_labels before set_label / set_label_bucket.
AI Titles: products are grouped in buckets; each bucket has a scope (which products), instructions, and a review queue. Generating titles costs AI usage and changes the feed, so run_ai_titles is always a proposal of at most ${MAX_RUN_PRODUCTS} products.`

const ok = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
const text = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }] })
const fail = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true })

// Turns thrown errors into a tool error the model can read and act on.
function tool<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args)
    } catch (err) {
      return fail(err instanceof AppError ? err.message : clientMessage(err, 'mcp tool'))
    }
  }
}

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const

const feedIdArg = z.string().uuid().describe('Feed id from list_shops')
const shopIdArg = z.string().uuid().describe('Shop id from list_shops')

const ruleSchema = z.object({
  field: z.string().describe("Product field: title, vendor, product_type, tags, status, handle, variants[0].price, variants[0].sku, variants[0].inventory_quantity, variants[0].barcode, or metafield:<namespace>.<key>"),
  operator: z.enum(['contains', 'does_not_contain', 'equals', 'not_equals', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty', 'greater_than', 'less_than']),
  value: z.string().default(''),
  case_sensitive: z.boolean().optional(),
})
const ruleSetSchema = z.object({
  match: z.enum(['all', 'any']).describe('all = every rule must hold (AND), any = one is enough (OR)'),
  rules: z.array(ruleSchema).max(50),
})

const scheduleSchema = z.object({
  frequency: z.enum(AUTO_SYNC_FREQUENCIES),
  time: z.string().regex(/^\d{2}:\d{2}$/).describe('HH:MM, Danish time. Used for daily; the first run of the day for the others.'),
})

const MAPPING_HELP = `Each field: { google_field, mapping_type, config }.
mapping_type and config:
- FIELD: { field: <source> }
- STATIC: { value: "text" }
- COMBINE: { blocks: [{ type: "field", value: <source>, skipIfPresent?: true } | { type: "text", value: "text" }], skipEmpty?: true }
  (skipEmpty leaves out a text block next to an empty field; skipIfPresent leaves out a field already contained, as a whole word, in the text built so far)
- PREFIX_SUFFIX: { field: <source>, prefix?: "", suffix?: "" }
- FIND_REPLACE: { field: <source>, pairs: [{ find, replace }] }
- TRUNCATE: { field: <source>, maxChars: 150 }
- STRIP_HTML: { field: <source> }
- LOOKUP: { field: <source>, rows: [{ from, to }], match: "exact"|"contains", caseSensitive?: false, fallback: "source"|"empty"|"static", fallbackValue?: "" }
- EXTRACT: { field: <source>, patterns: [{ pattern: "<JavaScript regex>", template: "$1/$2", ignoreCase: true }], lookup?: [{ from, to }] }
  Patterns are tried top-down; the first match wins and fills the template ($1, $2 … = groups). lookup rewrites each captured group first (ml → M/L). No match gives an empty value. Max 2000 characters per pattern; nested repetition such as (a+)+ is refused.
- REMOVE: {} removes the field's mapping.
Any type may add config.onlyIf = { conditions: [{ field: <source>, operator, value, logic: null|"AND"|"OR", ignoreCase?: true }], rules?: [{ conditions, value: ValueSpec }], else: ValueSpec } where ValueSpec = { type: "empty"|"static"|"field", value } or { type: "combine", blocks, skipEmpty? }. Condition operators: equals, not_equals, contains, not_contains, contains_word, not_contains_word, starts_with, ends_with, greater_than, less_than, is_empty, is_not_empty; each comparing operator also has a "<operator>_field" form whose value is another <source> instead of text (e.g. price less_than_field compare_at_price).
<source> is a standard field (see get_mapping → sources), "metafield:<namespace>.<key>", "ai_optimized_title", "url", or "feed:<feed field>" to reuse another mapped field's final value (e.g. feed:color).
Keep the config of the other kind of keys exactly as get_mapping shows them; only send the fields you change.`

export function createFeedFlowServer(caller: McpCaller): McpServer {
  const server = new McpServer({ name: 'FeedFlow', version: '1.0.0' }, { instructions: INSTRUCTIONS })
  const db = adminDb()
  const userId = caller.user.id
  let client: string | null = null
  const via = async () => (client ??= await clientName(db, caller.clientId))

  async function feed(feedId: string): Promise<OwnedFeed> {
    const f = await getOwnedFeed(userId, feedId)
    if (!f) throw new AppError('Feed not found, or you have no access to it')
    return f
  }
  async function shop(shopId: string) {
    const p = await getOwnedProject(userId, shopId)
    if (!p) throw new AppError('Shop not found, or you have no access to it')
    return p
  }
  async function propose(f: OwnedFeed, payload: Parameters<typeof proposeChange>[1]['payload'], summary: string, details: ChangeDetail[]) {
    const r = await proposeChange(db, { user: caller.user, client: await via(), feed: f, payload, summary, details })
    return describeOutcome(r, summary)
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  server.registerTool(
    'list_shops',
    {
      title: 'List shops and feeds',
      description: "Every shop in the user's agency with its feeds (id, channel, country, language, last product sync). Start here.",
      inputSchema: {},
      annotations: READ,
    },
    tool(async () => {
      const overview = await getAgencyOverview(db, userId)
      const ids = overview.shops.map((s) => s.id)
      const { data: feeds } = ids.length ? await db.from('feeds').select('*').in('project_id', ids) : { data: [] }
      const feedRows = (feeds ?? []) as (Record<string, unknown> & { id: string; project_id: string })[]
      const { data: markets } = feedRows.length
        ? await db.from('shop_settings').select('feed_id, selected_country, selected_locale, currency').in('feed_id', feedRows.map((f) => f.id))
        : { data: [] }
      const market = new Map(((markets ?? []) as { feed_id: string; selected_country: string | null; selected_locale: string | null; currency: string | null }[]).map((m) => [m.feed_id, m]))
      return ok(
        overview.shops.map((s) => ({
          shop_id: s.id,
          name: s.name,
          agency: s.accountName,
          address: s.address,
          source: s.source,
          shopify_connection: s.connection,
          feeds: feedRows
            .filter((f) => f.project_id === s.id)
            .map((f) => {
              const m = market.get(f.id)
              return {
                feed_id: f.id,
                name: f.name,
                channel: channelOf(f.channel as string).label,
                country: m?.selected_country ? countryName(m.selected_country) : null,
                language: m?.selected_locale ?? null,
                currency: m?.currency ?? null,
                last_product_sync: (f.last_synced_at as string | null) ?? null,
              }
            }),
        }))
      )
    })
  )

  server.registerTool(
    'get_feed',
    {
      title: 'Feed status',
      description: 'One feed: market, level (per product or variant), schedules, how many products are in or out of the feed, and the errors and warnings from the last validation.',
      inputSchema: { feed_id: feedIdArg },
      annotations: READ,
    },
    tool(async ({ feed_id }: { feed_id: string }) => {
      const f = (await feed(feed_id)) as OwnedFeed & Record<string, unknown>
      const [{ data: m }, { data: settings }, { data: cache }, { data: ads }, counts] = await Promise.all([
        db.from('shop_settings').select('selected_country, selected_locale, currency, market_url').eq('feed_id', feed_id).maybeSingle(),
        db.from('feed_settings').select('feed_mode').eq('feed_id', feed_id).maybeSingle(),
        db.from('feed_cache').select('generated_at, product_count, validation_status, validation_errors').eq('feed_id', feed_id).maybeSingle(),
        db.from('google_ads_feed_settings').select('*').eq('feed_id', feed_id).maybeSingle(),
        countFilteredProducts(feed_id).catch(() => null),
      ])
      const a = (ads ?? null) as Record<string, unknown> | null
      return ok({
        feed_id,
        name: f.name,
        channel: channelOf(f.channel).label,
        country: m?.selected_country ? countryName(m.selected_country) : null,
        language: m?.selected_locale ?? null,
        currency: m?.currency ?? null,
        storefront: m?.market_url ?? null,
        level: settings?.feed_mode ?? 'product',
        products: counts ? { total: counts.total, in_feed: counts.included, excluded: Math.max(0, counts.total - counts.included) } : null,
        last_product_sync: f.last_synced_at ?? null,
        product_sync_schedule: scheduleLabel(f.auto_sync_frequency as string, f.auto_sync_time as string),
        google_ads: a?.customer_id
          ? { customer: a.customer_name ?? a.customer_id, last_performance_sync: a.last_synced_at ?? null, performance_schedule: scheduleLabel(a.auto_sync_frequency as string, a.auto_sync_time as string) }
          : null,
        feed_file: cache
          ? { generated_at: cache.generated_at, items: cache.product_count, validation: cache.validation_status, issues: cache.validation_errors ?? [] }
          : null,
      })
    })
  )

  server.registerTool(
    'search_products',
    {
      title: 'Search products',
      description: 'Products in a feed, with whether each is in the feed (and why not) and the values it gets in the feed after mapping. Searches title, vendor, handle and tags.',
      inputSchema: {
        feed_id: feedIdArg,
        query: z.string().max(100).optional().describe('Text to search for; leave out to list from the start'),
        limit: z.number().int().min(1).max(25).default(10),
        offset: z.number().int().min(0).default(0),
      },
      annotations: READ,
    },
    tool(async ({ feed_id, query, limit, offset }: { feed_id: string; query?: string; limit: number; offset: number }) => {
      await feed(feed_id)
      let q = db
        .from('products')
        .select('*, metafields:product_metafields(*)', { count: 'exact' })
        .eq('feed_id', feed_id)
        .order('title', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + limit - 1)
      const search = (query ?? '').replace(/[,()*%_\\]/g, '').trim()
      if (search) q = q.or(`title.ilike.*${search}*,vendor.ilike.*${search}*,handle.ilike.*${search}*,tags.ilike.*${search}*`)
      const { data, error, count } = await q
      if (error) throw new Error(error.message)
      const rows = (data ?? []) as SupabaseProduct[]
      const view = await feedView(feed_id, rows)
      const shaped = toShopifyData(rows).products as unknown as Record<string, unknown>[]
      return ok({
        total: count ?? null,
        offset,
        products: rows.map((r, i) => {
          const v = view.get(r.shopify_id)
          const p = shaped[i] ?? {}
          const variant = ((p.variants as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
          return {
            id: r.shopify_id,
            title: r.title,
            vendor: p.vendor ?? null,
            product_type: p.product_type ?? null,
            status: p.status ?? null,
            price: variant.price ?? null,
            sku: variant.sku ?? null,
            stock: variant.inventory_quantity ?? null,
            in_feed: v?.inFeed ?? null,
            not_in_feed_because: v?.reason ?? null,
            feed_values: v?.fields ?? {},
          }
        }),
      })
    })
  )

  server.registerTool(
    'get_mapping',
    {
      title: 'Feed mapping',
      description: "How each feed field (title, brand, custom_label_0 …) is filled from the product data, plus the source fields and metafields that can be used. Read this before set_mapping.",
      inputSchema: { feed_id: feedIdArg },
      annotations: READ,
    },
    tool(async ({ feed_id }: { feed_id: string }) => {
      await feed(feed_id)
      const [{ data }, metafields] = await Promise.all([
        db.from('feed_mappings').select('google_field, mapping_type, config').eq('feed_id', feed_id).order('google_field'),
        getFeedMetafields(feed_id).catch(() => []),
      ])
      return ok({
        mappings: ((data ?? []) as MappingEntry[])
          .filter((m) => m.mapping_type)
          .map((m) => ({ ...m, summary: describeMapping(m.mapping_type, m.config) })),
        feed_fields: {
          required: REQUIRED_FIELDS,
          common: Object.fromEntries(COLLAPSIBLE_SECTIONS.map((s) => [s.title, s.fields])),
          advanced: Object.fromEntries(ADVANCED_CATEGORIES.map((c) => [c.title, c.fields])),
        },
        sources: {
          standard: STANDARD_FIELDS,
          special: ['url', 'ai_optimized_title'],
          metafields: metafields.map((mf) => ({ source: `metafield:${mf.namespace}.${mf.key}`, name: mf.name ?? null, products: mf.count })),
        },
      })
    })
  )

  server.registerTool(
    'get_rules',
    {
      title: 'Include / exclude rules',
      description: 'Which products the feed includes and excludes. A product is in the feed when it matches the include rules (or there are none) and does not match the exclude rules.',
      inputSchema: { feed_id: feedIdArg },
      annotations: READ,
    },
    tool(async ({ feed_id }: { feed_id: string }) => {
      await feed(feed_id)
      const current = await currentFilters(feed_id)
      return ok({
        include: toRuleSet(current.include),
        exclude: toRuleSet(current.exclude),
        readable: { include: readable(current.include), exclude: readable(current.exclude) },
      })
    })
  )

  server.registerTool(
    'get_performance',
    {
      title: 'Shop performance',
      description: "Google Ads cost, revenue and gross profit for a shop over the last N days, against the period before, per feed and per day. Only feeds with a Google Ads account count.",
      inputSchema: { shop_id: shopIdArg, days: z.union([z.literal(7), z.literal(14), z.literal(30), z.literal(90)]).default(30) },
      annotations: READ,
    },
    tool(async ({ shop_id, days }: { shop_id: string; days: 7 | 14 | 30 | 90 }) => {
      await shop(shop_id)
      return ok(await getShopPerformance(db, shop_id, days))
    })
  )

  server.registerTool(
    'get_activity',
    {
      title: 'Activity log',
      description: 'Who changed what in a shop, newest first, with before and after.',
      inputSchema: { shop_id: shopIdArg, limit: z.number().int().min(1).max(200).default(50) },
      annotations: READ,
    },
    tool(async ({ shop_id, limit }: { shop_id: string; limit: number }) => {
      const p = await shop(shop_id)
      const { rows } = await getShopActivity(db, shop_id, p.account_id)
      return ok(rows.slice(0, limit))
    })
  )

  server.registerTool(
    'list_changes',
    {
      title: 'Proposed changes',
      description: 'Changes asked for through this connector and what happened to them (pending, applied, rejected, failed). Leave out shop_id for every shop.',
      inputSchema: {
        shop_id: shopIdArg.optional(),
        status: z.enum(['pending', 'applied', 'rejected', 'failed']).optional(),
      },
      annotations: READ,
    },
    tool(async ({ shop_id, status }: { shop_id?: string; status?: 'pending' | 'applied' | 'rejected' | 'failed' }) => {
      let projectIds: string[]
      if (shop_id) projectIds = [(await shop(shop_id)).id]
      else {
        const accountIds = (await getMemberships(db, userId)).map((m) => m.account_id)
        const { data } = accountIds.length ? await db.from('projects').select('id').in('account_id', accountIds) : { data: [] }
        projectIds = ((data ?? []) as { id: string }[]).map((r) => r.id)
      }
      const rows = await listChanges(db, { projectIds, status })
      return ok(
        rows.map((r) => ({
          id: r.id,
          feed: r.feed_label,
          summary: r.summary,
          details: r.details,
          status: r.status,
          error: r.error,
          asked_by: r.requested_by_name,
          decided_by: r.decided_by_name,
          at: r.created_at,
        }))
      )
    })
  )

  // ── Writes (proposals) ─────────────────────────────────────────────────────

  server.registerTool(
    'set_mapping',
    {
      title: 'Change mapping',
      description: `Change how feed fields are filled. Only the fields you send change.\n${MAPPING_HELP}`,
      inputSchema: {
        feed_id: feedIdArg,
        fields: z
          .array(
            z.object({
              google_field: z.string().regex(/^[a-z0-9_]+$/).describe('Feed field, e.g. title, brand, custom_label_0'),
              mapping_type: z.enum(['FIELD', 'STATIC', 'COMBINE', 'PREFIX_SUFFIX', 'FIND_REPLACE', 'TRUNCATE', 'STRIP_HTML', 'LOOKUP', 'EXTRACT', 'REMOVE']),
              config: z.record(z.string(), z.unknown()).default({}),
            })
          )
          .min(1)
          .max(40),
      },
      annotations: WRITE,
    },
    tool(async ({ feed_id, fields }: { feed_id: string; fields: { google_field: string; mapping_type: string; config: Record<string, unknown> }[] }) => {
      const f = await feed(feed_id)
      for (const e of fields) {
        const problem = checkMapping(e.mapping_type, e.config)
        if (problem) return fail(`${e.google_field}: ${problem}`)
      }
      const { data: prevRows } = await db
        .from('feed_mappings')
        .select('google_field, mapping_type, config')
        .eq('feed_id', feed_id)
        .in('google_field', fields.map((e) => e.google_field))
      const prev = new Map(((prevRows ?? []) as MappingEntry[]).map((r) => [r.google_field, r]))
      const entries: MappingEntry[] = fields.map((e) =>
        e.mapping_type === 'REMOVE'
          ? { google_field: e.google_field, mapping_type: '', config: {} }
          : { google_field: e.google_field, mapping_type: e.mapping_type, config: e.config }
      )
      const details: ChangeDetail[] = entries.map((e) => {
        const p = prev.get(e.google_field)
        return {
          label: e.google_field,
          before: describeMapping(p?.mapping_type, p?.config),
          after: e.mapping_type ? describeMapping(e.mapping_type, e.config) : null,
        }
      })
      const names = entries.map((e) => e.google_field)
      const summary = `Mapping: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` and ${names.length - 4} more` : ''}`
      const outcome = await propose(f, { kind: 'mapping', entries }, summary, details)
      const warnings = extractWarnings(entries)
      return text(warnings.length ? `${outcome}\nWarning, these patterns will be skipped:\n${warnings.join('\n')}` : outcome)
    })
  )

  server.registerTool(
    'set_rules',
    {
      title: 'Change include / exclude rules',
      description: 'Replace the include rules, the exclude rules, or both. A side you leave out stays as it is. Send the whole rule list for a side (read get_rules first). An empty list removes all rules on that side.',
      inputSchema: { feed_id: feedIdArg, include: ruleSetSchema.optional(), exclude: ruleSetSchema.optional() },
      annotations: WRITE,
    },
    tool(async ({ feed_id, include, exclude }: { feed_id: string; include?: z.infer<typeof ruleSetSchema>; exclude?: z.infer<typeof ruleSetSchema> }) => {
      if (!include && !exclude) return fail('Send include, exclude or both')
      const f = await feed(feed_id)
      const current = await currentFilters(feed_id)
      const next = {
        include: include ? fromRuleSet(include) : current.include,
        exclude: exclude ? fromRuleSet(exclude) : current.exclude,
      }
      const details: ChangeDetail[] = []
      if (include) details.push({ label: 'Include', before: readable(current.include).join('\n') || null, after: readable(next.include).join('\n') || null })
      if (exclude) details.push({ label: 'Exclude', before: readable(current.exclude).join('\n') || null, after: readable(next.exclude).join('\n') || null })
      const summary = `Include / exclude: ${[include && 'include rules', exclude && 'exclude rules'].filter(Boolean).join(' and ')}`
      return text(await propose(f, { kind: 'filters', include: next.include, exclude: next.exclude }, summary, details))
    })
  )

  server.registerTool(
    'set_feed_settings',
    {
      title: 'Change feed settings',
      description: 'Feed level (one item per product or per variant), when products are fetched, and when Google Ads performance is fetched. Each setting you send becomes its own change.',
      inputSchema: {
        feed_id: feedIdArg,
        level: z.enum(['product', 'variant']).optional(),
        product_sync_schedule: scheduleSchema.optional(),
        performance_schedule: scheduleSchema.optional().describe('Only for a feed with a Google Ads account'),
      },
      annotations: WRITE,
    },
    tool(async ({ feed_id, level, product_sync_schedule, performance_schedule }: { feed_id: string; level?: 'product' | 'variant'; product_sync_schedule?: z.infer<typeof scheduleSchema>; performance_schedule?: z.infer<typeof scheduleSchema> }) => {
      if (!level && !product_sync_schedule && !performance_schedule) return fail('Send at least one setting')
      const f = (await feed(feed_id)) as OwnedFeed & Record<string, unknown>
      const out: string[] = []
      if (level) {
        const { data } = await db.from('feed_settings').select('feed_mode').eq('feed_id', feed_id).maybeSingle()
        const label = { product: 'Per product', variant: 'Per variant' }
        out.push(await propose(f, { kind: 'feed_mode', mode: level }, `Level: ${label[level]}`, [{ label: 'Level', before: label[(data?.feed_mode as 'product' | 'variant') ?? 'product'], after: label[level] }]))
      }
      if (product_sync_schedule) {
        const { frequency, time } = product_sync_schedule
        out.push(await propose(f, { kind: 'feed_schedule', frequency, time }, `Product sync: ${scheduleLabel(frequency, time)}`, [{ label: 'Fetch products', before: scheduleLabel(f.auto_sync_frequency as string, f.auto_sync_time as string), after: scheduleLabel(frequency, time) }]))
      }
      if (performance_schedule) {
        const { data } = await db.from('google_ads_feed_settings').select('*').eq('feed_id', feed_id).maybeSingle()
        const a = data as Record<string, unknown> | null
        if (!a?.customer_id) out.push('Performance schedule: the feed has no Google Ads account, so there is nothing to schedule.')
        else {
          const { frequency, time } = performance_schedule
          out.push(await propose(f, { kind: 'ads_schedule', frequency, time }, `Performance sync: ${scheduleLabel(frequency, time)}`, [{ label: 'Fetch performance', before: scheduleLabel(a.auto_sync_frequency as string, a.auto_sync_time as string), after: scheduleLabel(frequency, time) }]))
        }
      }
      return text(out.join('\n'))
    })
  )

  server.registerTool(
    'start_sync',
    {
      title: 'Fetch products now',
      description: 'Fetch the products for a feed from its source (Shopify or feed URL) now. Read-only towards the shop. At most once an hour per feed; can take up to a few minutes.',
      inputSchema: { feed_id: feedIdArg },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    tool(async ({ feed_id }: { feed_id: string }) => {
      const f = (await feed(feed_id)) as OwnedFeed & Record<string, unknown>
      const last = f.last_synced_at ? new Date(f.last_synced_at as string).getTime() : 0
      const minutes = Math.floor((Date.now() - last) / 60_000)
      if (last && minutes < 60) return fail(`Products were fetched ${minutes} min ago. Try again in ${60 - minutes} min.`)
      await enforceRateLimit(userId, 'shopify_sync')
      const client = await via()
      try {
        const result = await syncProducts(feed_id)
        await logActivity(db, { user: caller.user, via: client, feedId: feed_id, area: 'Sync', action: 'Products synced', after: `${formatNumber(result.synced)} products` })
        return ok({ synced: result.synced })
      } catch (err) {
        const message = clientMessage(err, 'mcp start_sync')
        await logActivity(db, { user: caller.user, via: client, feedId: feed_id, area: 'Sync', action: 'Sync failed', after: message })
        return fail(`The sync failed: ${message}`)
      }
    })
  )

  // ── Labels (Google Ads performance labels) ─────────────────────────────────

  const labelRuleSchema = z.object({
    metric: z.enum(BUCKET_METRICS),
    operator: z.enum(BUCKET_OPERATORS),
    value: z.number().optional().describe('Not used by is_empty / is_not_empty'),
    window_days: z.number().int().min(1).max(365).optional().describe("Overrides the label's window for this rule"),
  })
  const ruleText = (r: BucketRule) =>
    `${r.metric} ${r.operator}${r.value !== undefined ? ` ${r.value}` : ''}${r.windowDays ? ` (${r.windowDays} days)` : ''}`

  server.registerTool(
    'get_labels',
    {
      title: 'Google Ads labels',
      description:
        "The feed's custom labels (custom_label_0–4) computed from Google Ads performance: each label's values (buckets) in priority order with their rules, and how many products have each value now. Read this before set_label / set_label_bucket.",
      inputSchema: { feed_id: feedIdArg },
      annotations: READ,
    },
    tool(async ({ feed_id }: { feed_id: string }) => {
      await feed(feed_id)
      const [labels, lbuckets] = await Promise.all([listLabels(db, feed_id), listLabelBuckets(db, feed_id)])
      const counts = await Promise.all(
        lbuckets.map(async (b) => {
          const { count } = await db
            .from('google_ads_bucket_members')
            .select('id', { count: 'exact', head: true })
            .eq('bucket_id', b.id)
          return [b.id, count ?? 0] as const
        })
      )
      const n = new Map(counts)
      return ok({
        labels: labels.map((l) => ({
          label_id: l.id,
          name: l.name,
          slot: l.slot,
          level: l.level,
          window_days: l.window_days,
          in_feed: l.emit_to_feed,
          description: l.description,
          last_calculated: l.computed_at,
          buckets: lbuckets
            .filter((b) => b.label_id === l.id)
            .map((b) => ({
              bucket_id: b.id,
              name: b.name,
              value: b.value,
              priority: b.priority,
              match: b.match_type === 'ANY' ? 'any' : 'all',
              catch_all: b.is_fallback,
              rules: b.rules,
              products: n.get(b.id) ?? 0,
            })),
        })),
        metrics: BUCKET_METRICS,
        operators: BUCKET_OPERATORS,
      })
    })
  )

  server.registerTool(
    'set_label',
    {
      title: 'Create or change a label',
      description:
        'Create a custom label (leave out label_id) or change one. slot 0–4 is the custom_label_N it fills in the feed (null = not in the feed yet); level is per product or per variant; window_days is the lookback for its rules.',
      inputSchema: {
        feed_id: feedIdArg,
        label_id: z.string().uuid().optional(),
        name: z.string().min(1).max(80).optional(),
        slot: z.number().int().min(0).max(4).nullable().optional(),
        level: z.enum(['product', 'variant']).optional(),
        window_days: z.union([z.literal(7), z.literal(14), z.literal(30), z.literal(90), z.literal(180), z.literal(365)]).optional(),
        in_feed: z.boolean().optional().describe('Whether the label is written into the feed'),
        description: z.string().max(500).nullable().optional(),
      },
      annotations: WRITE,
    },
    tool(async (a: { feed_id: string; label_id?: string; name?: string; slot?: number | null; level?: 'product' | 'variant'; window_days?: number; in_feed?: boolean; description?: string | null }) => {
      const f = await feed(a.feed_id)
      const prev = a.label_id ? (await listLabels(db, a.feed_id)).find((l) => l.id === a.label_id) : undefined
      if (a.label_id && !prev) return fail('Label not found on this feed')
      if (!a.label_id && !a.name) return fail('A new label needs a name')
      const label = {
        id: a.label_id,
        name: a.name,
        slot: a.slot,
        level: a.level,
        window_days: a.window_days,
        emit_to_feed: a.in_feed,
        description: a.description,
      }
      const yn = (v: boolean | undefined) => (v === undefined ? null : v ? 'yes' : 'no')
      const details: ChangeDetail[] = [
        a.name !== undefined && { label: 'Name', before: prev?.name ?? null, after: a.name },
        a.slot !== undefined && { label: 'Slot', before: prev ? (prev.slot === null ? 'none' : `custom_label_${prev.slot}`) : null, after: a.slot === null ? 'none' : `custom_label_${a.slot}` },
        a.level !== undefined && { label: 'Level', before: prev?.level ?? null, after: a.level },
        a.window_days !== undefined && { label: 'Window', before: prev ? `${prev.window_days} days` : null, after: `${a.window_days} days` },
        a.in_feed !== undefined && { label: 'In the feed', before: prev ? yn(prev.emit_to_feed) : null, after: yn(a.in_feed) },
      ].filter(Boolean) as ChangeDetail[]
      return text(await propose(f, { kind: 'label_save', label }, `Label: ${a.name ?? prev?.name ?? 'new label'}`, details))
    })
  )

  server.registerTool(
    'set_label_bucket',
    {
      title: 'Create or change a label value',
      description:
        "Create a value (bucket) in a label (give label_id, leave out bucket_id) or change one. Values are checked in priority order (lowest first); the first whose rules match gives the product its value. A catch-all value takes every product no other value matched. After it is applied the label is recalculated.",
      inputSchema: {
        feed_id: feedIdArg,
        label_id: z.string().uuid().optional().describe('Required for a new value'),
        bucket_id: z.string().uuid().optional(),
        name: z.string().min(1).max(80).optional(),
        value: z.string().min(1).max(100).optional().describe('The text written into custom_label_N'),
        priority: z.number().int().min(0).max(1000).optional(),
        match: z.enum(['all', 'any']).optional(),
        catch_all: z.boolean().optional(),
        rules: z.array(labelRuleSchema).max(20).optional(),
        description: z.string().max(500).nullable().optional(),
      },
      annotations: WRITE,
    },
    tool(async (a: { feed_id: string; label_id?: string; bucket_id?: string; name?: string; value?: string; priority?: number; match?: 'all' | 'any'; catch_all?: boolean; rules?: z.infer<typeof labelRuleSchema>[]; description?: string | null }) => {
      const f = await feed(a.feed_id)
      const all = await listLabelBuckets(db, a.feed_id)
      const prev = a.bucket_id ? all.find((b) => b.id === a.bucket_id) : undefined
      if (a.bucket_id && !prev) return fail('Label value not found on this feed')
      if (!a.bucket_id) {
        if (!a.label_id || !(await listLabels(db, a.feed_id)).some((l) => l.id === a.label_id)) return fail('Give the label_id of a label on this feed')
        if (!a.name || !a.value) return fail('A new value needs a name and a value')
      }
      const rules: BucketRule[] | undefined = a.rules?.map((r) => ({ metric: r.metric, operator: r.operator, value: r.value, windowDays: r.window_days }))
      const bucket = {
        id: a.bucket_id,
        label_id: a.bucket_id ? undefined : a.label_id,
        name: a.name,
        value: a.value,
        priority: a.priority ?? (a.bucket_id ? undefined : all.filter((b) => b.label_id === a.label_id).length),
        match_type: a.match ? (a.match === 'any' ? ('ANY' as const) : ('ALL' as const)) : undefined,
        rules,
        is_fallback: a.catch_all,
        description: a.description,
      }
      const details: ChangeDetail[] = [
        a.name !== undefined && { label: 'Name', before: prev?.name ?? null, after: a.name },
        a.value !== undefined && { label: 'Value', before: prev?.value ?? null, after: a.value },
        a.priority !== undefined && { label: 'Priority', before: prev ? String(prev.priority) : null, after: String(a.priority) },
        a.match !== undefined && { label: 'Match', before: prev ? (prev.match_type === 'ANY' ? 'any rule' : 'all rules') : null, after: a.match === 'any' ? 'any rule' : 'all rules' },
        a.catch_all !== undefined && { label: 'Catch-all', before: prev ? (prev.is_fallback ? 'yes' : 'no') : null, after: a.catch_all ? 'yes' : 'no' },
        rules && { label: 'Rules', before: prev ? prev.rules.map(ruleText).join('\n') || null : null, after: rules.map(ruleText).join('\n') || null },
      ].filter(Boolean) as ChangeDetail[]
      const name = a.name ?? prev?.name ?? ''
      return text(await propose(f, { kind: 'label_bucket_save', bucket }, `Label value: ${name}`, details))
    })
  )

  server.registerTool(
    'recalculate_labels',
    {
      title: 'Recalculate labels',
      description:
        "Re-apply the label rules to the Google Ads figures already fetched (like the Recalculate button). Changes which products have which value; no settings change and nothing is fetched from Google. Leave out label_id for all labels.",
      inputSchema: { feed_id: feedIdArg, label_id: z.string().uuid().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    tool(async ({ feed_id, label_id }: { feed_id: string; label_id?: string }) => {
      await feed(feed_id)
      const result = label_id ? await recomputeLabel(db, feed_id, label_id) : await recomputeFeed(db, feed_id)
      return ok({
        labels: result.labels.map((l) => ({
          name: l.name,
          slot: l.slot,
          products: l.entities,
          with_data: l.withData,
          assigned: l.assigned,
          without_value: l.unlabelled,
          moved: l.moved,
          values: l.perBucket.map((b) => ({ name: b.name, value: b.value, products: b.count })),
          warnings: l.warnings,
        })),
        warnings: result.warnings,
      })
    })
  )

  // ── AI Titles ──────────────────────────────────────────────────────────────

  async function titleBucket(feedId: string, bucketId: string) {
    const b = await titleBuckets.getBucket(feedId, bucketId)
    if (!b) throw new AppError('AI Titles bucket not found on this feed')
    return b
  }
  const methodLabel = (m: string) => (m === 'rule_based' ? 'Rule-based' : 'Automatic')

  server.registerTool(
    'list_title_buckets',
    {
      title: 'AI Titles buckets',
      description: "The feed's AI Titles buckets: groups of products that get titles in the same style, with how many products each has and how many titles are AI-generated, edited by hand, or waiting for review.",
      inputSchema: { feed_id: feedIdArg },
      annotations: READ,
    },
    tool(async ({ feed_id }: { feed_id: string }) => {
      await feed(feed_id)
      const list = await titleBuckets.listBuckets(feed_id)
      return ok(
        list.map((b) => ({
          bucket_id: b.id,
          name: b.name,
          method: b.method,
          products: b.memberCount,
          ai_generated: b.aiGenerated,
          edited_by_hand: b.humanEdited,
          waiting_for_review: b.needsReview,
        }))
      )
    })
  )

  server.registerTool(
    'get_title_bucket',
    {
      title: 'AI Titles bucket',
      description: "One bucket: its scope (include / exclude rules deciding which products it holds), the instructions and input fields the AI writes titles from, and the example titles people approved or rejected.",
      inputSchema: { feed_id: feedIdArg, bucket_id: z.string().uuid() },
      annotations: READ,
    },
    tool(async ({ feed_id, bucket_id }: { feed_id: string; bucket_id: string }) => {
      await feed(feed_id)
      const b = await titleBucket(feed_id, bucket_id)
      const [filters, config, examples] = await Promise.all([
        titleBuckets.getBucketFilters(bucket_id),
        titleWorkshop.getBucketTitleConfig(bucket_id),
        titleWorkshop.listBucketExamples(bucket_id),
      ])
      return ok({
        bucket_id: b.id,
        name: b.name,
        method: b.method,
        scope: { include: toRuleSet(filters.include as FilterConfig), exclude: toRuleSet(filters.exclude as FilterConfig) },
        instructions: config.instructions,
        input_fields: config.input_fields,
        examples: examples
          .filter((e) => e.status !== 'candidate')
          .map((e) => ({ status: e.status, product_ref: e.product_ref, title: e.generated_title, note: e.note || null })),
      })
    })
  )

  server.registerTool(
    'list_title_review',
    {
      title: 'AI titles waiting for review',
      description: 'Titles the AI proposed that failed a check and wait for a person (too long, a value not found in the product data, …). Approve, edit or reject them with review_ai_titles.',
      inputSchema: { feed_id: feedIdArg, bucket_id: z.string().uuid(), limit: z.number().int().min(1).max(100).default(30) },
      annotations: READ,
    },
    tool(async ({ feed_id, bucket_id, limit }: { feed_id: string; bucket_id: string; limit: number }) => {
      await feed(feed_id)
      await titleBucket(feed_id, bucket_id)
      const items = await titleSvc.listBucketReview(feed_id, bucket_id)
      return ok({
        total: items.length,
        items: items.slice(0, limit).map((i) => ({
          product_ref: i.product_ref,
          original_title: i.original_title,
          proposed_title: i.proposed_title,
          issues: i.validation_issues.map((v) => `${v.code}: ${v.detail}`),
        })),
      })
    })
  )

  server.registerTool(
    'set_title_bucket',
    {
      title: 'Create or change an AI Titles bucket',
      description: 'Create a bucket (leave out bucket_id; give a name) or rename one / change its method. Method "auto" lets the AI write titles from the instructions; "rule_based" builds them from per-product-type rules set on the AI Titles page.',
      inputSchema: {
        feed_id: feedIdArg,
        bucket_id: z.string().uuid().optional(),
        name: z.string().min(1).max(80).optional(),
        method: z.enum(['auto', 'rule_based']).optional(),
      },
      annotations: WRITE,
    },
    tool(async (a: { feed_id: string; bucket_id?: string; name?: string; method?: 'auto' | 'rule_based' }) => {
      const f = await feed(a.feed_id)
      const prev = a.bucket_id ? await titleBucket(a.feed_id, a.bucket_id) : null
      if (!prev && !a.name) return fail('A new bucket needs a name')
      const details: ChangeDetail[] = [
        a.name !== undefined && { label: 'Name', before: prev?.name ?? null, after: a.name },
        a.method !== undefined && { label: 'Method', before: prev ? methodLabel(prev.method) : null, after: methodLabel(a.method) },
      ].filter(Boolean) as ChangeDetail[]
      return text(
        await propose(f, { kind: 'title_bucket_save', bucket: { id: a.bucket_id, name: a.name, method: a.method } }, `AI Titles bucket: ${a.name ?? prev?.name ?? 'new bucket'}`, details)
      )
    })
  )

  server.registerTool(
    'set_title_scope',
    {
      title: 'Change which products a bucket holds',
      description: "Replace a bucket's include / exclude rules (same rule format as set_rules). When applied, the bucket holds the products the rules match, except products already in another bucket, which stay there.",
      inputSchema: { feed_id: feedIdArg, bucket_id: z.string().uuid(), include: ruleSetSchema, exclude: ruleSetSchema },
      annotations: WRITE,
    },
    tool(async ({ feed_id, bucket_id, include, exclude }: { feed_id: string; bucket_id: string; include: z.infer<typeof ruleSetSchema>; exclude: z.infer<typeof ruleSetSchema> }) => {
      const f = await feed(feed_id)
      const b = await titleBucket(feed_id, bucket_id)
      const prev = await titleBuckets.getBucketFilters(bucket_id)
      const inc = fromRuleSet(include)
      const exc = fromRuleSet(exclude)
      const details: ChangeDetail[] = [
        { label: 'Include', before: readable(prev.include as FilterConfig).join('\n') || null, after: readable(inc).join('\n') || null },
        { label: 'Exclude', before: readable(prev.exclude as FilterConfig).join('\n') || null, after: readable(exc).join('\n') || null },
      ]
      return text(await propose(f, { kind: 'title_scope', bucket_id, include: inc, exclude: exc }, `Scope in ${b.name}`, details))
    })
  )

  server.registerTool(
    'set_title_instructions',
    {
      title: 'Change how a bucket writes titles',
      description: 'The instructions the AI follows for this bucket, and the input fields it reads (standard fields or metafield:<namespace>.<key>, see get_mapping → sources). Send both.',
      inputSchema: {
        feed_id: feedIdArg,
        bucket_id: z.string().uuid(),
        instructions: z.string().max(4000),
        input_fields: z.array(z.string().max(120)).max(30),
      },
      annotations: WRITE,
    },
    tool(async ({ feed_id, bucket_id, instructions, input_fields }: { feed_id: string; bucket_id: string; instructions: string; input_fields: string[] }) => {
      const f = await feed(feed_id)
      const b = await titleBucket(feed_id, bucket_id)
      const prev = await titleWorkshop.getBucketTitleConfig(bucket_id)
      const details: ChangeDetail[] = [
        { label: 'Instructions', before: prev.instructions || null, after: instructions || null },
        { label: 'Input fields', before: prev.input_fields.join(', ') || null, after: input_fields.join(', ') || null },
      ]
      return text(await propose(f, { kind: 'title_config', bucket_id, config: { instructions, input_fields } }, `Instructions in ${b.name}`, details))
    })
  )

  server.registerTool(
    'review_ai_titles',
    {
      title: 'Approve or reject AI titles',
      description: 'Decide on titles waiting for review (list_title_review): approve the proposed title, approve with your own edited title, or reject (the product keeps its original title). Approved titles go into the feed.',
      inputSchema: {
        feed_id: feedIdArg,
        bucket_id: z.string().uuid(),
        decisions: z
          .array(z.object({ product_ref: z.string().min(1), action: z.enum(['approve', 'reject']), title: z.string().min(1).max(300).optional().describe('An edited title to approve instead of the proposed one') }))
          .min(1)
          .max(100),
      },
      annotations: WRITE,
    },
    tool(async ({ feed_id, bucket_id, decisions }: { feed_id: string; bucket_id: string; decisions: { product_ref: string; action: 'approve' | 'reject'; title?: string }[] }) => {
      const f = await feed(feed_id)
      const b = await titleBucket(feed_id, bucket_id)
      const queue = new Map((await titleSvc.listBucketReview(feed_id, bucket_id)).map((i) => [i.product_ref, i]))
      const unknown = decisions.filter((d) => !queue.has(d.product_ref)).map((d) => d.product_ref)
      if (unknown.length) return fail(`Not waiting for review in this bucket: ${unknown.join(', ')}`)
      const details: ChangeDetail[] = decisions.slice(0, 50).map((d) => {
        const item = queue.get(d.product_ref)!
        return d.action === 'reject'
          ? { label: `Reject ${d.product_ref}`, before: item.proposed_title, after: item.original_title }
          : { label: `Approve ${d.product_ref}`, before: item.original_title, after: d.title ?? item.proposed_title }
      })
      return text(await propose(f, { kind: 'title_review', bucket_id, decisions }, `Review AI titles in ${b.name}: ${decisions.length}`, details))
    })
  )

  server.registerTool(
    'run_ai_titles',
    {
      title: 'Generate AI titles',
      description: `Generate AI titles for a bucket's products. Costs AI usage and changes the titles in the feed, so it is always a proposal, of at most ${MAX_RUN_PRODUCTS} products (ask again to continue). By default only products without a title; rerun=true also redoes AI titles (titles edited by hand are never overwritten). Titles that fail a check go to the review queue.`,
      inputSchema: {
        feed_id: feedIdArg,
        bucket_id: z.string().uuid(),
        rerun: z.boolean().default(false),
        max_products: z.number().int().min(1).max(MAX_RUN_PRODUCTS).default(MAX_RUN_PRODUCTS),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    tool(async ({ feed_id, bucket_id, rerun, max_products }: { feed_id: string; bucket_id: string; rerun: boolean; max_products: number }) => {
      const f = await feed(feed_id)
      const b = await titleBucket(feed_id, bucket_id)
      const plan = await titleBuckets.planBucketRun(feed_id, bucket_id, { rerun, includeHumanEdited: false })
      if (plan.targets.length === 0) return fail('Nothing to generate: every product in this bucket already has a title. Use rerun=true to redo AI titles.')
      const n = Math.min(plan.targets.length, max_products)
      const details: ChangeDetail[] = [
        { label: 'products', before: null, after: `${n} / ${plan.targets.length} (${rerun ? 'all products again (not hand-edited)' : 'products without a title'})` },
      ]
      return text(await propose(f, { kind: 'title_run', bucket_id, rerun, limit: n }, `Generate AI titles in ${b.name}: ${n} products`, details))
    })
  )

  return server

  // ── helpers ────────────────────────────────────────────────────────────────

  async function currentFilters(feedId: string): Promise<{ include: FilterConfig; exclude: FilterConfig }> {
    const { data } = await db.from('feed_filters').select('filter_type, operator, rules').eq('feed_id', feedId)
    const rows = (data ?? []) as { filter_type: string; operator: 'AND' | 'OR'; rules: FilterConfig['rules'] | null }[]
    const pick = (t: string): FilterConfig => {
      const r = rows.find((x) => x.filter_type === t)
      return { operator: r?.operator ?? 'AND', rules: r?.rules ?? [] }
    }
    return { include: pick('include'), exclude: pick('exclude') }
  }
}

function toRuleSet(c: FilterConfig) {
  return {
    match: c.operator === 'OR' ? 'any' : 'all',
    rules: c.rules.filter((r) => isActiveRule(r as FeedFilterRule)).map((r) => ({ field: r.field, operator: r.operator, value: r.value, case_sensitive: r.caseSensitive ?? true })),
  }
}

function fromRuleSet(s: { match: 'all' | 'any'; rules: { field: string; operator: string; value: string; case_sensitive?: boolean }[] }): FilterConfig {
  return {
    operator: s.match === 'any' ? 'OR' : 'AND',
    rules: s.rules.map((r) => ({ field: r.field, operator: r.operator, value: r.value, caseSensitive: r.case_sensitive ?? false })),
  }
}

const readable = (c: FilterConfig): string[] =>
  c.rules.map((r) => r as FeedFilterRule).filter(isActiveRule).map(describeRule)

// The shape checks the mapping editor guarantees by construction.
function checkMapping(type: string, config: Record<string, unknown>): string | null {
  const str = (k: string) => typeof config[k] === 'string' && (config[k] as string).length > 0
  switch (type) {
    case 'FIELD':
    case 'STRIP_HTML':
    case 'PREFIX_SUFFIX':
      return str('field') ? null : 'config.field is required'
    case 'STATIC':
      return typeof config.value === 'string' ? null : 'config.value (text) is required'
    case 'COMBINE':
      return Array.isArray(config.blocks) && config.blocks.length ? null : 'config.blocks is required'
    case 'FIND_REPLACE':
      return str('field') && Array.isArray(config.pairs) ? null : 'config.field and config.pairs are required'
    case 'TRUNCATE':
      return str('field') && Number(config.maxChars) > 0 ? null : 'config.field and config.maxChars are required'
    case 'LOOKUP':
      return str('field') && Array.isArray(config.rows) ? null : 'config.field and config.rows are required'
    case 'EXTRACT':
      return str('field') && Array.isArray(config.patterns) && config.patterns.length ? null : 'config.field and config.patterns are required'
    case 'REMOVE':
      return null
    default:
      return `unknown mapping_type ${type}`
  }
}

function describeOutcome(r: ProposeResult, summary: string): string {
  if (r.status === 'pending') return `${summary}: waiting for approval in FeedFlow (Shop › API / MCP), change #${r.id}. Nothing has changed yet.`
  if (r.status === 'applied')
    return `${summary}: applied (the agency allows changes without approval), change #${r.id}.${r.warnings?.length ? ` Note: ${r.warnings.join(' ')}` : ''}`
  return `${summary}: could not be applied: ${r.error ?? 'unknown error'} (change #${r.id}).`
}
