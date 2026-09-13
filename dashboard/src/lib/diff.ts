export type Op = "eq" | "del" | "ins";

export interface Piece {
  op: Op;
  text: string;
  /** Offsets into the side's own string. */
  start: number;
  end: number;
}

interface Token {
  text: string;
  start: number;
}

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

// Beyond this many DP cells the middle section is shown as one replacement.
const MAX_CELLS = 4_000_000;

const tokenize = (s: string): Token[] => [...s.matchAll(TOKEN)].map((m) => ({ text: m[0], start: m.index ?? 0 }));

function merge(tokens: Token[], ops: Op[]): Piece[] {
  const out: Piece[] = [];
  tokens.forEach((t, i) => {
    const op = ops[i] ?? "eq";
    const last = out[out.length - 1];
    const end = t.start + t.text.length;
    if (last && last.op === op) {
      last.text += t.text;
      last.end = end;
    } else {
      out.push({ op, text: t.text, start: t.start, end });
    }
  });
  return out;
}

/** Token-level LCS diff. Left pieces are eq/del over `a`, right pieces are eq/ins over `b`. */
export function diffTokens(a: string, b: string): { left: Piece[]; right: Piece[] } {
  const A = tokenize(a);
  const B = tokenize(b);
  const opsA = new Array<Op>(A.length).fill("eq");
  const opsB = new Array<Op>(B.length).fill("eq");

  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre]!.text === B[pre]!.text) pre++;
  let suf = 0;
  while (
    suf < A.length - pre &&
    suf < B.length - pre &&
    A[A.length - 1 - suf]!.text === B[B.length - 1 - suf]!.text
  )
    suf++;

  const n = A.length - suf - pre;
  const m = B.length - suf - pre;

  if (n > 0 && m > 0 && n * m <= MAX_CELLS) {
    const w = m + 1;
    const dp = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] =
          A[pre + i]!.text === B[pre + j]!.text
            ? dp[(i + 1) * w + j + 1]! + 1
            : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[pre + i]!.text === B[pre + j]!.text) {
        i++;
        j++;
      } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
        opsA[pre + i++] = "del";
      } else {
        opsB[pre + j++] = "ins";
      }
    }
    for (; i < n; i++) opsA[pre + i] = "del";
    for (; j < m; j++) opsB[pre + j] = "ins";
  } else {
    for (let i = 0; i < n; i++) opsA[pre + i] = "del";
    for (let j = 0; j < m; j++) opsB[pre + j] = "ins";
  }

  return { left: merge(A, opsA), right: merge(B, opsB) };
}
