"use client";

import { useEffect, useState } from "react";
import { countdownTo } from "../../lib/money";

/** Live countdown to a unix-seconds deadline. */
export default function Countdown({ targetUnix }: { targetUnix: string | number }) {
  const target = Number(targetUnix);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1_000));
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1_000)), 1_000);
    return () => clearInterval(timer);
  }, []);
  return <span>{countdownTo(target, now)}</span>;
}
