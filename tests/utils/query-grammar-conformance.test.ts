import { matchesRecordFilter } from "@classytic/repo-core/filter";
import { runQueryGrammarConformance } from "@classytic/repo-core/testing";
import qs from "qs";
import { ArcQueryParser } from "../../src/utils/queryParser.js";

/** Parsed exactly as arc's server does (`createApp`'s querystring parser). */
const parseQs = (query: string) =>
  qs.parse(query, { depth: 5, parameterLimit: 100, arrayLimit: 20, allowPrototypes: false });

runQueryGrammarConformance("arc ArcQueryParser", {
  parse(query, options) {
    const parser = new ArcQueryParser({
      maxLimit: options.maxLimit,
      defaultLimit: options.defaultLimit,
      strictFilterFields: true,
      ...(options.allowedFilterFields
        ? { allowedFilterFields: [...options.allowedFilterFields] }
        : {}),
      ...(options.allowedSortFields ? { allowedSortFields: [...options.allowedSortFields] } : {}),
    });
    const parsed = parser.parse(parseQs(query) as Record<string, unknown>);
    return {
      matches: (doc) => matchesRecordFilter(doc, parsed.filters as Record<string, unknown>),
      limit: parsed.limit ?? 0,
      page: parsed.after ? undefined : parsed.page,
      after: parsed.after,
      sort: parsed.sort as Record<string, 1 | -1> | undefined,
    };
  },
});
