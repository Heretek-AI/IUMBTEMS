// String ordering shared by deterministic dataset builders (telemetry,
// distillation): one locale-aware ascending comparator, so every sorted
// output reads the same everywhere. (Sonar S2871: bare `<` sorts are out.)
export const compareStrings = (a: string, b: string): number => a.localeCompare(b)
