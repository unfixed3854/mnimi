import { configureSync, getConfig, getConsoleSink, getLogger } from "@logtape/logtape";
import { makeSanitizingSink } from "./effect/logging.ts";

if (getConfig() === null) {
  configureSync({
    reset: true,
    sinks: { console: makeSanitizingSink(getConsoleSink()) },
    loggers: [
      { category: ["mnimi"], sinks: ["console"], lowestLevel: "warning" },
      { category: ["logtape", "meta"], sinks: ["console"], lowestLevel: "error" },
    ],
  });
}

export { getLogger };
