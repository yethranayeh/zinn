export const isProductionSite =
  import.meta.env.PROD && import.meta.env.PUBLIC_SITE_ENV === "production";
