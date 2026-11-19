import { ConfigError } from "./config.ts";

export const checkPrAutoTrack = (value: unknown): void => {
  if (value !== undefined && typeof value !== "boolean")
    throw new ConfigError("invalid prAutoTrack: expected true or false");
};
