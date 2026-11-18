import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Order, runOrders } from "../tools/open_orders.ts";
import { OTHER, ORDER, PULSE, rig, rsync } from "./owner-now-sync-setup.ts";

describe.skipIf(!rsync)("owner-now-sync.sh: what the macmini and the lane summary hand over", () => {
  test("an orders array of numbers is ignored in the summary as in open_orders, and the log names the lane", () => {
    const s = rig(PULSE);
    const exact = "1572108521254944830";
    writeFileSync(
      join(s.h, "lanes", "numeric.json"),
      `{"key":"numeric","status":"working","lastActivityAt":5,"orders":[${exact}, null, "${OTHER}"]}`,
    );
    const r = s.run();
    expect(r.out).toContain("numeric.json orders: 2 non-string entries ignored (ids must be strings)");
    const summary = JSON.parse(readFileSync(join(s.macbookDir, "lanes", "numeric.json"), "utf8"));
    expect(summary).toEqual({ key: "numeric", status: "working", lastActivityAt: 5, orders: [OTHER] });
    const inbound = join(s.root, "inbound-numeric.log");
    writeFileSync(inbound, [ORDER, OTHER].map((id) => `INBOUND discord 1 ${id} from=owner ref=- "지시"`).join("\n"));
    const attached = (lanes: string): string[] => {
      const out: string[] = [];
      runOrders(["--inbound", `macbook=${inbound}`, "--lanes", `macbook=${lanes}`, "--json", "--since", "3650d"], (l) =>
        out.push(l),
      );
      const orders = (JSON.parse(out[0]!) as { orders: Order[] }).orders;
      return orders.flatMap((o) => o.lanes.filter((l) => l.key === "numeric").map(() => o.id));
    };
    expect(attached(join(s.macbookDir, "lanes"))).toEqual(attached(join(s.h, "lanes")));
    expect(attached(join(s.h, "lanes"))).toEqual([OTHER]);
  });

  test("a lead-alive.json the macmini no longer has is not judged from an old local copy", () => {
    const s = rig(PULSE);
    s.mini("lead-alive.json", '{"at":2}');
    s.run();
    expect(readFileSync(join(s.root, "saw-macmini.txt"), "utf8")).toBe("lead-alive.json\n");
    rmSync(join(s.remote, "sobaegi-lead", "state", "lead-alive.json"));
    s.run();
    expect(readFileSync(join(s.root, "saw-macmini.txt"), "utf8")).toBe("");
    expect(s.ls(s.fromMini)).toEqual([]);
    expect(readFileSync(join(s.root, "fetched.txt"), "utf8")).not.toBe("\n");
  });
});
