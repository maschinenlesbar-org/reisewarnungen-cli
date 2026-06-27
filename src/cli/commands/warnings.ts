import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, renderJson } from "../shared.js";
import { ReiseError } from "../../client/errors.js";

export function registerWarningCommands(program: Command, deps: CliDeps): void {
  program
    .command("list")
    .description("All travel warnings, keyed by content id (raw response)")
    .action(
      action(deps, async ({ client, global }) => {
        renderJson(deps, global, await client.list());
      }),
    );

  program
    .command("countries")
    .description("Flattened country overview (id, country, warning flags)")
    .option("--warned-only", "only countries with a warning of any kind in force")
    .action(
      action(deps, async ({ client, global, opts }) => {
        let entries = await client.summaries();
        if (opts["warnedOnly"]) {
          entries = entries.filter(
            (e) => e.warning || e.partialWarning || e.situationWarning || e.situationPartWarning,
          );
        }
        renderJson(deps, global, entries);
      }),
    );

  program
    .command("get <contentId>")
    .description("One country's full travel warning (with HTML content)")
    .action(
      action(deps, async ({ client, global }, [id]) => {
        // A content id is the numeric key from `list` / the `id` field of
        // `countries`. Validate it up front: an empty id would hit a
        // trailing-slash URL that can only 404, and the upstream leniently parses
        // a *leading* integer — so `get 226768x` would otherwise silently return
        // 226768's country. Rejecting non-numeric ids keeps that consistent
        // (every malformed id is a usage error, not a surprise hit or a 404).
        if (!/^\d+$/.test(id ?? "")) {
          throw new ReiseError(
            `Invalid contentId "${id ?? ""}". Expected a numeric content id (e.g. 226768).`,
          );
        }
        renderJson(deps, global, await client.get(id!));
      }),
    );
}
