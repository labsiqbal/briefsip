export type PackMember = { skill: string; version: number };
export function validatePackMembers(value: unknown): PackMember[] {
  if (!Array.isArray(value) || !value.length || value.length > 64) throw new Error('Skill pack must contain 1 to 64 skills.');
  const members = value.map(member => {
    if (!member || typeof member !== 'object' || Array.isArray(member) || Object.keys(member).some(key => !['skill', 'version'].includes(key)) || typeof member.skill !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(member.skill) || !Number.isSafeInteger(member.version) || member.version < 1) throw new Error('Invalid skill pack member.');
    return { skill: member.skill, version: member.version };
  });
  if (new Set(members.map(member => member.skill)).size !== members.length) throw new Error('Skills must not repeat within a skill pack.');
  return members;
}
