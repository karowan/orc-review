/**
 * Deterministic program verification (rev 2, flat model) — the second "law"
 * step. The planner proposes; this verifier enforces. Checked by AST:
 *   - every lane key of every eligible bot runs exactly once; a merged call
 *     may carry several keys, each interpolated verbatim
 *   - judgment prompts are headed by a PROMPTS reference (never paraphrased)
 *   - verbatim bots' keys sit in single-key calls
 *   - judgment calls carry SCHEMAS.findings
 *   - every call IS a judgment lane or the aggregator — no support tier
 *   - exactly one aggregator: MERGE_PROMPT-headed, SCHEMAS.consolidated,
 *     zero PROMPTS references
 *   - every judgment leaf is writable inside the disposable sandbox
 *   - no cwd/host/ext escapes, no redeclared injected constants
 *
 * (Lane isolation — "no lane's output in another lane's prompt" — is stated to
 * the planner but needs data-flow analysis to prove; the structural rules here
 * still prevent cross-lane prompt references.)
 */
import ts from "typescript";
import { flatLanes, type CompiledReviewer } from "./contracts.js";

const RESERVED = new Set(["PROMPTS", "NOTES", "SCHEMAS", "CTX", "MERGE_PROMPT", "AGG"]);
const FORBIDDEN_OPTS = new Set(["cwd", "host"]);

interface JudgmentCall {
  keys: string[];
  headed: boolean; // prompt begins with a PROMPTS ref
  schema: string | null;
  writable: boolean;
  where: string;
}

export function verifyProgram(
  source: string,
  reviewers: CompiledReviewer[],
  limits: { maxJudgmentCalls?: number } = {},
): string[] {
  const problems: string[] = [];
  const sf = ts.createSourceFile("review.orc.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

  const lanes = flatLanes(reviewers);
  const knownKeys = new Set(lanes.map((l) => l.promptKey));
  const verbatimKeys = new Set(lanes.filter((l) => l.botVerbatim).map((l) => l.promptKey));

  let hasDefaultExport = false;
  const judgmentCalls: JudgmentCall[] = [];
  const consolidatedCalls: Array<{ mergeHeaded: boolean; promptsRefs: number; settled: boolean }> = [];
  const seenDecl = new Map<string, number>();

  const stripParens = (e: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(e) ? stripParens(e.expression) : e;

  /** PROMPTS["key"] / PROMPTS.key → key, else null. */
  const promptsKey = (expr: ts.Node): string | null => {
    if (ts.isElementAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "PROMPTS") {
      const arg = stripParens(expr.argumentExpression);
      return ts.isStringLiteralLike(arg) ? arg.text : "<dynamic>";
    }
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "PROMPTS") {
      return expr.name.text;
    }
    return null;
  };

  /** Every PROMPTS reference anywhere inside an expression. */
  const collectRefs = (expr: ts.Node, out: string[]): void => {
    const key = promptsKey(expr);
    if (key !== null) {
      out.push(key);
      return; // don't descend into the access expression itself
    }
    ts.forEachChild(expr, (c) => collectRefs(c, out));
  };

  const headIs = (expr: ts.Expression, test: (e: ts.Expression) => boolean): boolean => {
    const e = stripParens(expr);
    if (test(e)) return true;
    if (ts.isTemplateExpression(e) && e.head.text === "" && e.templateSpans.length > 0) {
      return test(stripParens(e.templateSpans[0].expression));
    }
    return false;
  };
  const promptsHeaded = (expr: ts.Expression) => headIs(expr, (e) => promptsKey(e) !== null);
  const mergeHeaded = (expr: ts.Expression) => headIs(expr, (e) => ts.isIdentifier(e) && e.text === "MERGE_PROMPT");

  const schemaRef = (obj: ts.ObjectLiteralExpression | undefined): string | null => {
    if (!obj) return null;
    for (const prop of obj.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "schema") {
        return stripParens(prop.initializer).getText(sf).replace(/\s+/g, "");
      }
    }
    return null;
  };

  const isWritable = (obj: ts.ObjectLiteralExpression | undefined): boolean =>
    !!obj?.properties.some(
      (prop) =>
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "readOnly" &&
        prop.initializer.kind === ts.SyntaxKind.FalseKeyword,
    );

  const callName = (node: ts.CallExpression): string => {
    const callee = stripParens(node.expression);
    return ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : "";
  };

  const nestedInSettle = (node: ts.Node): boolean => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isCallExpression(parent) && callName(parent) === "settle") return true;
    }
    return false;
  };

  const noteCall = (
    promptExpr: ts.Expression,
    opts: ts.ObjectLiteralExpression | undefined,
    where: string,
    settled = false,
  ) => {
    const refs: string[] = [];
    collectRefs(promptExpr, refs);
    const schema = schemaRef(opts);
    if (refs.length > 0) {
      judgmentCalls.push({ keys: refs, headed: promptsHeaded(promptExpr), schema, writable: isWritable(opts), where });
      if (mergeHeaded(promptExpr)) {
        problems.push(`${where}: a judgment prompt must not also start from MERGE_PROMPT`);
      }
    } else if (schema === "SCHEMAS.consolidated" || mergeHeaded(promptExpr)) {
      consolidatedCalls.push({ mergeHeaded: mergeHeaded(promptExpr), promptsRefs: refs.length, settled });
      if (schema !== "SCHEMAS.consolidated") {
        problems.push(`${where}: the aggregator call must carry schema: SCHEMAS.consolidated`);
      }
    } else {
      // No support tier exists: every call is a judgment lane or the aggregator.
      problems.push(
        `${where}: not a judgment lane (no PROMPTS reference) and not the aggregator — support stages are not allowed; a bot that wants extra work (e.g. running tests) declares it as a lane`,
      );
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isExportAssignment(node) && !node.isExportEquals) hasDefaultExport = true;

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && RESERVED.has(node.name.text)) {
      seenDecl.set(node.name.text, (seenDecl.get(node.name.text) ?? 0) + 1);
      if (seenDecl.get(node.name.text)! > 1) problems.push(`program redeclares injected constant ${node.name.text}`);
    }

    if (ts.isIdentifier(node) && node.text === "ext") {
      const p = node.parent;
      const isUsage =
        (ts.isPropertyAccessExpression(p) && p.expression === node) ||
        (ts.isElementAccessExpression(p) && p.expression === node) ||
        ts.isCallExpression(p);
      if (isUsage) problems.push("program touches ext — extension leaves are not available to review plans");
    }

    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && FORBIDDEN_OPTS.has(node.name.text)) {
      problems.push(`option "${node.name.text}" is not allowed in a review plan`);
    }

    if (ts.isCallExpression(node)) {
      const calleeName = callName(node);

      if (calleeName === "phase" && node.arguments.length >= 1) {
        const nameArg = stripParens(node.arguments[0]);
        if (!ts.isStringLiteralLike(nameArg)) problems.push("phase() name must be a string literal");
      }

      if (calleeName === "agent" && node.arguments.length >= 1) {
        const opts = node.arguments.length >= 2 ? stripParens(node.arguments[1]) : undefined;
        noteCall(
          node.arguments[0],
          opts && ts.isObjectLiteralExpression(opts) ? opts : undefined,
          "an agent() call",
          nestedInSettle(node),
        );
      }

      if (calleeName === "parallel" && node.arguments.length >= 1) {
        const arr = stripParens(node.arguments[0]);
        if (ts.isArrayLiteralExpression(arr)) {
          for (const el of arr.elements) {
            const spec = stripParens(el as ts.Expression);
            if (ts.isObjectLiteralExpression(spec)) {
              const promptProp = spec.properties.find(
                (p): p is ts.PropertyAssignment =>
                  ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "prompt",
              );
              if (promptProp) noteCall(promptProp.initializer, spec, "a parallel lane");
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);

  if (!hasDefaultExport) problems.push("program has no default export");

  // Lane coverage: every key exactly once across all judgment calls.
  const usage = new Map<string, number>();
  for (const call of judgmentCalls) {
    if (!call.headed) {
      problems.push(`${call.where} referencing PROMPTS must START with a PROMPTS[...] text (judgment is verbatim-headed)`);
    }
    if (call.schema !== "SCHEMAS.findings") {
      problems.push(`${call.where} carrying judgment (keys ${call.keys.join(", ")}) must have schema: SCHEMAS.findings`);
    }
    if (!call.writable) {
      problems.push(`${call.where} carrying judgment (keys ${call.keys.join(", ")}) must set readOnly: false`);
    }
    for (const key of call.keys) {
      if (key === "<dynamic>") {
        problems.push(`${call.where} uses a dynamic PROMPTS access — keys must be string literals`);
        continue;
      }
      if (!knownKeys.has(key)) {
        problems.push(`unknown lane key PROMPTS[${JSON.stringify(key)}]`);
        continue;
      }
      usage.set(key, (usage.get(key) ?? 0) + 1);
    }
    if (call.keys.length > 1) {
      for (const key of call.keys) {
        if (verbatimKeys.has(key)) {
          problems.push(
            `lane PROMPTS[${JSON.stringify(key)}] belongs to a verbatim bot and cannot be merged with other lanes`,
          );
        }
      }
    }
  }
  for (const key of knownKeys) {
    const n = usage.get(key) ?? 0;
    if (n !== 1) problems.push(`lane PROMPTS[${JSON.stringify(key)}] must run exactly once, found ${n}`);
  }
  if (limits.maxJudgmentCalls !== undefined && judgmentCalls.length > limits.maxJudgmentCalls) {
    problems.push(
      `plan uses ${judgmentCalls.length} judgment calls; planner.max_calls permits at most ${limits.maxJudgmentCalls}`,
    );
  }

  if (consolidatedCalls.length !== 1) {
    problems.push(`expected exactly one aggregator call with SCHEMAS.consolidated, found ${consolidatedCalls.length}`);
  } else if (!consolidatedCalls[0].mergeHeaded) {
    problems.push("the aggregator prompt must start with MERGE_PROMPT");
  } else if (consolidatedCalls[0].settled) {
    problems.push("the aggregator must return its consolidated value directly and cannot be wrapped in settle()");
  }

  return problems;
}
