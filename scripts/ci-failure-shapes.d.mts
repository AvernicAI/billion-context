interface TapCounts {
    pass: number;
    fail: number;
    cancelled: number;
}

type PhaseFailureVerdict =
    | { kind: "swallowed"; files: string[] }
    | { kind: "cancelled-drain"; counts: TapCounts }
    | { kind: "concrete"; counts: TapCounts | null };

export function extractSwallowedFiles(output: string, baseToFile: Map<string, string>): string[];
export function extractTapCounts(output: string): TapCounts | null;
export function classifyPhaseFailure(output: string, baseToFile: Map<string, string>): PhaseFailureVerdict;
export function describeRetryOutcome(verdict: PhaseFailureVerdict): string;
