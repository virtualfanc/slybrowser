/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SLY_API_ORIGIN?: string;
  readonly VITE_PAYNOW_LAUNCH_MONTHLY_URL?: string;
  readonly VITE_PAYNOW_STUDIO_MONTHLY_URL?: string;
  readonly VITE_PAYNOW_FLEET_MONTHLY_URL?: string;
  readonly VITE_PAYNOW_GRID_MONTHLY_URL?: string;
  readonly VITE_PAYNOW_SUBSCRIPTIONS_URL?: string;
  readonly VITE_PAID_PREVIEW_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
