export const INVESTIGATION_DEMO = {
  baseline: '2026-08',
  current: '2026-09',
  csv: `BillingPeriodStart,BillingPeriodEnd,BillingCurrency,BilledCost,ServiceName,ChargeCategory,ProviderName,BillingAccountId,SubAccountId,ResourceId,ResourceName,SkuId,x_SkuMeterId,PricingCategory,PricingQuantity,PricingUnit
2026-08-01,2026-09-01,BRL,1000,Virtual Machines,Usage,Microsoft,demo-account,demo-sub,/subscriptions/demo-sub/resourceGroups/demo/providers/Microsoft.Compute/virtualMachines/checkout,checkout,demo-sku,demo-meter,Standard,100,Hours
2026-09-01,2026-10-01,BRL,1450,Virtual Machines,Usage,Microsoft,demo-account,demo-sub,/subscriptions/demo-sub/resourceGroups/demo/providers/Microsoft.Compute/virtualMachines/checkout,checkout,demo-sku,demo-meter,Standard,120,Hours
2026-08-01,2026-09-01,BRL,200,Storage,Usage,Microsoft,demo-account,demo-sub,/subscriptions/demo-sub/resourceGroups/demo/providers/Microsoft.Storage/storageAccounts/archive,archive,,,,,
2026-09-01,2026-10-01,BRL,180,Storage,Usage,Microsoft,demo-account,demo-sub,/subscriptions/demo-sub/resourceGroups/demo/providers/Microsoft.Storage/storageAccounts/archive,archive,,,,,
2026-08-01,2026-09-01,BRL,-150,Virtual Machines,Credit,Microsoft,demo-account,demo-sub,,,,,,,
2026-09-01,2026-10-01,BRL,-50,Virtual Machines,Credit,Microsoft,demo-account,demo-sub,,,,,,,
2026-09-01,2026-10-01,BRL,300,Reservations,Purchase,Microsoft,demo-account,demo-sub,,,,,,,
2026-08-01,2026-09-01,USD,10,Storage,Usage,Microsoft,demo-account-usd,demo-sub-usd,,,,,,,
2026-09-01,2026-10-01,USD,12,Storage,Usage,Microsoft,demo-account-usd,demo-sub-usd,,,,,,,
`,
} as const;
