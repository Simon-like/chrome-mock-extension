import type { Group, MockStore, Project } from '../types.js';

const TECHNICAL_PATH_SEGMENTS = new Set([
  'api',
  'gateway',
  'generic',
  'h5',
  'm',
  'mock',
  'openapi',
  'rest',
  'service',
]);

export interface OrganizeResult {
  store: MockStore;
  organizedRuleCount: number;
  createdProjectCount: number;
  createdGroupCount: number;
}

export function deriveGroupName(url: string): string {
  const pathname = extractPathname(url);
  const segments = pathname
    .split('/')
    .map((segment) => safeDecode(segment).trim())
    .filter(Boolean);

  const meaningful = segments.find((segment) => {
    const lower = segment.toLowerCase();
    return !TECHNICAL_PATH_SEGMENTS.has(lower) && !/^v\d+$/.test(lower) && !/^gw\d+$/.test(lower);
  });

  return meaningful || '其他接口';
}

export function normalizeHostPatterns(hosts: string[]): string[] {
  return [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean))].sort();
}

export function hostFromPageUrl(pageUrl?: string | null): string | null {
  if (!pageUrl) return null;
  try {
    const url = new URL(pageUrl);
    return /^https?:$/.test(url.protocol) ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function findProjectByHosts(store: MockStore, hosts: string[]): Project | undefined {
  const key = hostKey(hosts);
  if (!key) return undefined;
  return store.projects.find(
    (project) => project.hostScope.mode === 'include' && hostKey(project.hostScope.patterns) === key,
  );
}

export function findGroup(
  store: MockStore,
  projectId: string | null,
  name: string,
): Group | undefined {
  const key = name.trim().toLowerCase();
  return store.groups.find(
    (group) => group.projectId === projectId && group.name.trim().toLowerCase() === key,
  );
}

export function projectNameFromHosts(hosts: string[]): string {
  const normalized = normalizeHostPatterns(hosts);
  if (normalized.length === 0) return '未命名项目';
  return normalized.length === 1 ? normalized[0]! : `${normalized[0]} 等 ${normalized.length} 个域名`;
}

export function organizeLegacyRules(
  store: MockStore,
  idFactory: () => string,
): OrganizeResult {
  const projects = [...store.projects];
  const groups = [...store.groups];
  let organizedRuleCount = 0;
  let createdProjectCount = 0;
  let createdGroupCount = 0;

  const rules = store.rules.map((rule) => {
    if (rule.groupId) return rule;

    let projectId = rule.projectId;
    const hosts = normalizeHostPatterns(rule.match.hosts);

    if (!projectId && hosts.length > 0) {
      let project = findProjectByHosts({ ...store, projects, groups }, hosts);
      if (!project) {
        project = {
          id: idFactory(),
          name: projectNameFromHosts(hosts),
          hostScope: { mode: 'include', patterns: hosts },
          defaultShellTemplateId: null,
        };
        projects.push(project);
        createdProjectCount++;
      }
      projectId = project.id;
    }

    const groupName = deriveGroupName(rule.match.url);
    let group = findGroup({ ...store, projects, groups }, projectId, groupName);
    if (!group) {
      group = {
        id: idFactory(),
        name: groupName,
        projectId,
        collapsed: false,
        defaultShellTemplateId: null,
      };
      groups.push(group);
      createdGroupCount++;
    }

    organizedRuleCount++;
    return { ...rule, projectId, groupId: group.id };
  });

  return {
    store: { ...store, projects, groups, rules },
    organizedRuleCount,
    createdProjectCount,
    createdGroupCount,
  };
}

function extractPathname(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return value.split(/[?#]/, 1)[0] ?? '';
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hostKey(hosts: string[]): string {
  return normalizeHostPatterns(hosts).join('\n');
}
