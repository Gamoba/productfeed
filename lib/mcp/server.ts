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
import { scheduleLabel, type FilterConfig, type MappingEntry } from '@/lib/ops/feedConfig'
import { clientName, listChanges, proposeChange, type ChangeDetail, type ProposeResult } from '@/lib/mcp/changes'
import type { McpCaller } from '@/lib/mcp/auth'

const INSTRUCTIONS = `FeedFlow builds product feeds (Google Shopping and other channels) from an agency's shops.
Hierarchy: agency → shop → feed (one channel + country). Start with list_shops to get shop and feed ids.
Reads are free. Every change (set_mapping, set_rules, set_feed_settings) is a proposal: it is applied at once only if the agency allows changes without approval; otherwise it waits for a person to approve it in FeedFlow under Shop › API / MCP. Always tell the user which it was.
FeedFlow never writes to Shopify. Product data comes from Shopify (read-only); FeedFlow decides how it is mapped and filtered into the feed.
Before changing a mapping, read get_mapping and check the result on real products with search_products.`

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
- COMBINE: { blocks: [{ type: "field", value: <source> } | { type: "text", value: "text" }] }
- PREFIX_SUFFIX: { field: <source>, prefix?: "", suffix?: "" }
- FIND_REPLACE: { field: <source>, pairs: [{ find, replace }] }
- TRUNCATE: { field: <source>, maxChars: 150 }
- STRIP_HTML: { field: <source> }
- LOOKUP: { field: <source>, rows: [{ from, to }], match: "exact"|"contains", caseSensitive?: false, fallback: "source"|"empty"|"static", fallbackValue?: "" }
- REMOVE: {} removes the field's mapping.
Any type may add config.onlyIf = { conditions: [{ field: <source>, operator, value, logic: null|"AND"|"OR" }], rules?: [{ conditions, value: ValueSpec }], else: ValueSpec } where ValueSpec = { type: "empty"|"static"|"field", value } or { type: "combine", blocks }. Condition operators: equals, not_equals, contains, not_contains, starts_with, ends_with, greater_than, less_than, is_empty, is_not_empty, equals_field, not_equals_field, greater_than_field, less_than_field.
<source> is a standard field (see get_mapping → sources), "metafield:<namespace>.<key>", "ai_optimized_title" or "url".
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
              mapping_type: z.enum(['FIELD', 'STATIC', 'COMBINE', 'PREFIX_SUFFIX', 'FIND_REPLACE', 'TRUNCATE', 'STRIP_HTML', 'LOOKUP', 'REMOVE']),
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
      const summary = `Mapping: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` og ${names.length - 4} mere` : ''}`
      return text(await propose(f, { kind: 'mapping', entries }, summary, details))
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
      if (include) details.push({ label: 'Inkludér', before: readable(current.include).join('\n') || null, after: readable(next.include).join('\n') || null })
      if (exclude) details.push({ label: 'Ekskludér', before: readable(current.exclude).join('\n') || null, after: readable(next.exclude).join('\n') || null })
      const summary = `Inkludér / ekskludér: ${[include && 'inkluderingsregler', exclude && 'ekskluderingsregler'].filter(Boolean).join(' og ')}`
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
        const label = { product: 'Pr. vare', variant: 'Pr. variant' }
        out.push(await propose(f, { kind: 'feed_mode', mode: level }, `Niveau: ${label[level]}`, [{ label: 'Niveau', before: label[(data?.feed_mode as 'product' | 'variant') ?? 'product'], after: label[level] }]))
      }
      if (product_sync_schedule) {
        const { frequency, time } = product_sync_schedule
        out.push(await propose(f, { kind: 'feed_schedule', frequency, time }, `Hent varer: ${scheduleLabel(frequency, time)}`, [{ label: 'Hent varer', before: scheduleLabel(f.auto_sync_frequency as string, f.auto_sync_time as string), after: scheduleLabel(frequency, time) }]))
      }
      if (performance_schedule) {
        const { data } = await db.from('google_ads_feed_settings').select('*').eq('feed_id', feed_id).maybeSingle()
        const a = data as Record<string, unknown> | null
        if (!a?.customer_id) out.push('Performance schedule: the feed has no Google Ads account, so there is nothing to schedule.')
        else {
          const { frequency, time } = performance_schedule
          out.push(await propose(f, { kind: 'ads_schedule', frequency, time }, `Hent performance: ${scheduleLabel(frequency, time)}`, [{ label: 'Hent performance', before: scheduleLabel(a.auto_sync_frequency as string, a.auto_sync_time as string), after: scheduleLabel(frequency, time) }]))
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
    case 'REMOVE':
      return null
    default:
      return `unknown mapping_type ${type}`
  }
}

function describeOutcome(r: ProposeResult, summary: string): string {
  if (r.status === 'pending') return `${summary}: waiting for approval in FeedFlow (Shop › API / MCP), change #${r.id}. Nothing has changed yet.`
  if (r.status === 'applied') return `${summary}: applied (the agency allows changes without approval), change #${r.id}.`
  return `${summary}: could not be applied: ${r.error ?? 'unknown error'} (change #${r.id}).`
}
