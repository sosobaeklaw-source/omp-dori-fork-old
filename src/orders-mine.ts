// This Mac's open owner orders: tools/open_orders.ts over this home's records and the macmini's copy synced under
// `<stateDir>/macmini/`. `dori orders`, the hourly loop's audit and the lead pulse all read them the same way.
import { join } from "node:path";
import { type Order, runOrders } from "../tools/open_orders.ts";
import { homeStateDir } from "./lane-model.ts";

/** The open_orders arguments for the records of `home` and its `stateDir`, the macmini's synced copy included. */
export const ordersArgv = (home: string, stateDir: string, since = "3d"): string[] => [
  ...["--inbound", `macbook=${join(stateDir, "inbound.log")}`, "--lanes", `macbook=${join(home, "lanes")}`],
  ...["--sent-log", join(stateDir, "discord-sent.log"), "--ready-log", join(stateDir, "ready-reply.log")],
  ...["--closed", join(stateDir, "orders-closed.log")],
  ...["--reply-log", join(stateDir, "macmini", "reply.log")],
  ...["--orders-json", `macmini=${join(stateDir, "macmini", "open-orders.json")}`],
  ...["--since", since],
];

const lines = (root: string, now: number, extra: string[]): string[] => {
  const out: string[] = [];
  runOrders([...ordersArgv(root, homeStateDir(root)), "--mine", "macbook", ...extra], (line) => out.push(line), now);
  return out;
};

/** What `dori orders --mine --json` prints for the harness home `root`: every order of the last 3 days, closed ones too. */
export const ordersMine = (root: string, now: number): { orders: Order[]; notes: string[] } =>
  JSON.parse(lines(root, now, ["--json"]).join("\n")) as { orders: Order[]; notes: string[] };

/** What `dori orders --mine` prints, one entry per line: the open orders, or `열린 지시 없음`. */
export const ordersText = (root: string, now: number): string[] => lines(root, now, []);
