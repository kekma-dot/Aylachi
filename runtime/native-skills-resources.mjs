// Compose only the public ResourceLoader interface; leave MCP/executable tools and lifecycle intact.
export function withNativeSkillResources(loader, skills, { sessionId, getTurnContext }) {
  if (!skills.length) return loader;
  return new Proxy(loader, {
    get(target, property) {
      if (property === 'getSkills') return () => {
        const turn = getTurnContext();
        const active = turn && Object.isFrozen(turn) && turn.sessionId === sessionId &&
          typeof turn.turnId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(turn.turnId);
        return { skills: active ? skills : [], diagnostics: [] };
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
