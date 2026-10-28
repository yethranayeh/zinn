import { z } from "zod";

const maximumDateTimestamp = 8_640_000_000_000_000;
const timestampMessage = "Time must be integer epoch milliseconds within the JavaScript Date range";

export const timestampSchema = z
  .number({ error: timestampMessage })
  .int(timestampMessage)
  .min(-maximumDateTimestamp, timestampMessage)
  .max(maximumDateTimestamp, timestampMessage);
