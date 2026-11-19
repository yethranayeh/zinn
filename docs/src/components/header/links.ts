import { integrationsHub } from "../../config/integrations-hub";

export const headerLinks = [
  { name: "Docs", path: "/docs" },
  { name: integrationsHub.title, path: integrationsHub.path },
  { name: "CHANGELOG", path: "/changelog" },
] as const;
