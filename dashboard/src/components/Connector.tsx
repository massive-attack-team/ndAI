import type { Verdict } from "../types";

const TONE: Record<Verdict, string> = {
  PERMIT: "border-emerald/60 text-emerald",
  MUTATED: "border-amber/60 text-amber",
  HALT: "border-rose/70 text-rose",
};

/** The cable between ledger and inspector, after the reference art. Decorative. */
export function Connector({ verdict }: { verdict: Verdict }) {
  const tone = TONE[verdict];
  return (
    <div aria-hidden className="relative hidden flex-col items-center lg:flex">
      <div className={`absolute left-0 right-0 top-16 border-t ${tone}`} />
      <div className={`mt-16 h-10 border-l ${tone}`} />
      <div className="flex gap-1">
        <span className={`size-1.5 border ${tone}`} />
        <span className={`size-1.5 border ${tone}`} />
      </div>
      <div className={`h-6 border-l ${tone}`} />
      <div className={`flex flex-col items-center border px-1 py-2 font-sans text-xs font-black leading-[1.2] ${tone}`}>
        {"TRACE".split("").map((c, i) => (
          <span key={i}>{c}</span>
        ))}
      </div>
      <div className={`flex-1 border-l border-dashed ${tone}`} />
    </div>
  );
}
