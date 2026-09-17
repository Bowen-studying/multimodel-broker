import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The M3 eval set is only useful if a fixture cannot silently rot: a missing `criticalClaims`
 * entry or a fabricated `knownFailures` block would make "the supervisor caught it" unverifiable.
 * These checks keep `docs/evals/fixtures/*.json` machine-valid against the schema in
 * docs/evals/README.md.
 */
const FIXTURE_DIR = fileURLToPath(new URL("../../docs/evals/fixtures/", import.meta.url));
const REQUIRED_VERDICTS = new Set(["required", "optional"]);

interface Claim {
  claim: string;
  verdict: string;
}
interface ObservedWorker {
  worker: string;
  taskId: string;
  observedAt: string;
}
interface Fixture {
  id: string;
  domain: string;
  mode: string;
  task: string;
  criticalClaims: Claim[];
  knownFailures?: Array<ObservedWorker & { claim: string; explanation: string }>;
  knownCorrect?: Array<ObservedWorker & { note: string }>;
  expectedAdjudication: { mustDetect: string[]; mustNotClaim?: string[]; resolution: string };
  source: string;
}

const files = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith(".json"));
const fixtures = files.map((name) => ({ name, value: JSON.parse(readFileSync(FIXTURE_DIR + name, "utf8")) as Fixture }));

describe("M3 evaluation fixtures", () => {
  it("has at least the lattice/basis fixture", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain("001-lattice-basis.json");
  });

  it("keeps ids well-formed, unique and matched to the file name", () => {
    const ids = fixtures.map((entry) => entry.value.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { name, value } of fixtures) {
      expect(value.id).toMatch(/^\d{3}-[a-z0-9-]+$/);
      expect(`${value.id}.json`).toBe(name);
    }
  });

  it("declares a valid mode, non-empty task and a traceable source", () => {
    for (const { value } of fixtures) {
      expect(["single", "parallel_compare", "adjudication"]).toContain(value.mode);
      expect(value.task.trim().length).toBeGreaterThan(0);
      expect(value.domain.trim().length).toBeGreaterThan(0);
      // A claim nobody can check is not a fixture; require a stated provenance.
      expect(value.source.trim().length).toBeGreaterThan(0);
    }
  });

  it("gives every fixture checkable critical claims", () => {
    for (const { value } of fixtures) {
      expect(Array.isArray(value.criticalClaims)).toBe(true);
      expect(value.criticalClaims.length).toBeGreaterThanOrEqual(1);
      for (const claim of value.criticalClaims) {
        expect(claim.claim.trim().length).toBeGreaterThan(0);
        expect(REQUIRED_VERDICTS.has(claim.verdict)).toBe(true);
      }
      expect(value.expectedAdjudication.mustDetect.length).toBeGreaterThanOrEqual(1);
      expect(value.expectedAdjudication.resolution.trim().length).toBeGreaterThan(0);
    }
  });

  it("only records failures/correct answers that point at a real task id", () => {
    for (const { value } of fixtures) {
      for (const observed of [...(value.knownFailures ?? []), ...(value.knownCorrect ?? [])]) {
        expect(observed.worker.trim().length).toBeGreaterThan(0);
        // Observed means observed: the task id is what makes it verifiable in the store.
        expect(observed.taskId).toMatch(/^[0-9a-f-]{36}$/);
        expect(observed.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
      for (const failure of value.knownFailures ?? []) {
        expect(failure.explanation.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
