// The Google fields the mapping editor offers and the standard source fields
// a mapping can read. Shared by the mapping page and the MCP tools, so Claude
// is told exactly what the editor allows.

export const REQUIRED_FIELDS = [
  'id', 'title', 'description', 'link', 'image_link', 'availability', 'price', 'brand',
] as const

export const COLLAPSIBLE_SECTIONS: { title: string; fields: string[] }[] = [
  {
    title: 'Identifikatorer',
    fields: ['condition', 'gtin', 'mpn', 'identifier_exists', 'item_group_id'],
  },
  {
    title: 'Pris',
    fields: ['sale_price', 'sale_price_effective_date', 'cost_of_goods_sold', 'auto_pricing_min_price'],
  },
  {
    title: 'Produktkategori',
    fields: ['google_product_category', 'product_type'],
  },
  {
    title: 'Varianter',
    fields: ['color', 'size', 'gender', 'age_group', 'material', 'pattern', 'size_type', 'size_system'],
  },
  {
    title: 'Kampagner',
    fields: ['custom_label_0', 'custom_label_1', 'custom_label_2', 'custom_label_3', 'custom_label_4', 'promotion_id'],
  },
  {
    title: 'Fragt',
    fields: ['shipping', 'shipping_label', 'shipping_weight', 'max_handling_time', 'min_handling_time'],
  },
  {
    title: 'Flere billeder og medier',
    fields: ['additional_image_link', 'lifestyle_image_link', 'short_title'],
  },
]

// Advanced fields — only shown in the UI when the user explicitly adds them
// via the "+ Tilføj felt" modal. Grouped here purely for the modal's layout.
export const ADVANCED_CATEGORIES: { title: string; fields: string[] }[] = [
  {
    title: 'Pris og lagerstatus',
    fields: [
      'availability_date', 'expiration_date',
      'unit_pricing_measure', 'unit_pricing_base_measure',
      'installment', 'subscription_cost',
      'loyalty_program', 'maximum_retail_price',
    ],
  },
  {
    title: 'Produktdetaljer',
    fields: [
      'adult', 'multipack', 'is_bundle',
      'product_detail', 'product_highlight',
      'product_length', 'product_width', 'product_height', 'product_weight',
    ],
  },
  {
    title: 'Certificering og energi',
    fields: [
      'certification',
      'energy_efficiency_class', 'min_energy_efficiency_class', 'max_energy_efficiency_class',
    ],
  },
  {
    title: 'Medier',
    fields: ['video_link', 'virtual_model_link', 'mobile_link'],
  },
  {
    title: 'Kampagner og annoncer',
    fields: [
      'ads_redirect',
      'excluded_destination', 'included_destination',
      'shopping_ads_excluded_country',
      'pause',
    ],
  },
  {
    title: 'Fragt (avanceret)',
    fields: [
      'carrier_shipping', 'handling_cutoff_time', 'minimum_order_value',
      'shipping_length', 'shipping_width', 'shipping_height',
      'ships_from_country',
      'shipping_transit_business_days', 'shipping_handling_business_days',
      'free_shipping_threshold', 'return_policy_label',
    ],
  },
]

export const STANDARD_FIELDS = [
  'id',
  'item_group_id',
  'title',
  'body_html',
  'vendor',
  'handle',
  'url',
  'tags',
  'status',
  'product_type',
  'published_at',
  'created_at',
  'updated_at',
  'collections',
  'variants[0].id',
  'variants[0].title',
  'variants[0].price',
  'variants[0].currency',
  'variants[0].compare_at_price',
  'variants[0].sku',
  'variants[0].barcode',
  'variants[0].weight',
  'variants[0].inventory_quantity',
  'variants[0].option1',
  'variants[0].option2',
  'variants[0].option3',
  'images[0].src',
  'images[1].src',
  'images[2].src',
  'images[3].src',
  'images[4].src',
]
