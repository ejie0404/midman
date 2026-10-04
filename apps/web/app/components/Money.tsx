import { formatUSDC } from "../../lib/money";

/** Exact-money display. Never floats: formats smallest-unit bigint strings. */
export default function Money({ units, prefix }: { units: string | bigint; prefix?: string }) {
  return (
    <span>
      {prefix ? `${prefix} ` : ""}
      {formatUSDC(units)}
    </span>
  );
}
