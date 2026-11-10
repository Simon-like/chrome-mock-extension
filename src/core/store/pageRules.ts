import { matchHostScope } from '../engine/matcher.js';
import type { MockStore, Rule } from '../types.js';

export interface PageRuleSelection {
  rules: Rule[];
  enabledCount: number;
  hiddenGlobalCount: number;
  hiddenGlobalEnabledCount: number;
}

export function selectPageRules(
  store: MockStore,
  host: string | null,
  hitRuleIds: string[],
): PageRuleSelection {
  const hitRank = new Map<string, number>();
  hitRuleIds.forEach((id, index) => {
    if (!hitRank.has(id)) hitRank.set(id, index);
  });

  const projects = new Map(store.projects.map((project) => [project.id, project]));
  const selected = store.rules.filter((rule) => {
    if (hitRank.has(rule.id)) return true;
    if (!host || !hasExplicitHostScope(rule, store)) return false;
    return matchHostScope(
      rule.match.hosts,
      projects.get(rule.projectId ?? '')?.hostScope,
      host,
    );
  });

  selected.sort((left, right) => {
    const leftRank = hitRank.get(left.id);
    const rightRank = hitRank.get(right.id);
    if (leftRank !== undefined || rightRank !== undefined) {
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      return leftRank - rightRank;
    }
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
    return store.rules.indexOf(left) - store.rules.indexOf(right);
  });

  const selectedIds = new Set(selected.map((rule) => rule.id));
  const hiddenGlobal = store.rules.filter(
    (rule) => !selectedIds.has(rule.id) && !hasExplicitHostScope(rule, store),
  );

  return {
    rules: selected,
    enabledCount: selected.filter((rule) => rule.enabled).length,
    hiddenGlobalCount: hiddenGlobal.length,
    hiddenGlobalEnabledCount: hiddenGlobal.filter((rule) => rule.enabled).length,
  };
}

function hasExplicitHostScope(rule: Rule, store: MockStore): boolean {
  if (rule.match.hosts.length > 0) return true;
  if (!rule.projectId) return false;
  const project = store.projects.find((item) => item.id === rule.projectId);
  return !!project && project.hostScope.patterns.length > 0;
}
