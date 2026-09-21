import { selectDevelopmentDatabase } from "./dev-environment";

selectDevelopmentDatabase();

await import("../packages/cli/index");
