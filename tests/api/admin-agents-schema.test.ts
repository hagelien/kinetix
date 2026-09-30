import { describe, expect, it } from 'vitest';
import { createAgentSchema, patchAgentSchema } from '../../api/_lib/schemas';

describe('createAgentSchema (shared admin contract)', () => {
  it('accepts a minimal valid payload', () => {
    const r = createAgentSchema.safeParse({
      email: 'agent@example.com',
      username: 'kinetix-agent',
      name: 'Kinetix maintainer',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.email).toBe('agent@example.com');
      expect(r.data.role).toBe('contributor');
    }
  });

  it('lowercases the email', () => {
    const r = createAgentSchema.safeParse({
      email: 'Agent@Example.COM',
      username: 'kinetix-agent',
      name: 'Kinetix maintainer',
    });
    expect(r.success && r.data.email).toBe('agent@example.com');
  });

  it('rejects an invalid username (spaces)', () => {
    const r = createAgentSchema.safeParse({
      email: 'a@b.com',
      username: 'has space',
      name: 'X',
    });
    expect(r.success).toBe(false);
  });

  it('accepts a valid modelTier and rejects an unknown one', () => {
    const ok = createAgentSchema.safeParse({
      email: 'a@b.com',
      username: 'kinetix-opus-verifier',
      name: 'Flagship verifier',
      modelTier: 'flagship',
    });
    expect(ok.success && ok.data.modelTier).toBe('flagship');
    const bad = createAgentSchema.safeParse({
      email: 'a@b.com',
      username: 'x',
      name: 'X',
      modelTier: 'gigachad',
    });
    expect(bad.success).toBe(false);
  });

  it('patchAgentSchema accepts modelTier and null (clear), rejects unknown', () => {
    expect(patchAgentSchema.safeParse({ modelTier: 'mid' }).success).toBe(true);
    expect(patchAgentSchema.safeParse({ modelTier: null }).success).toBe(true);
    expect(patchAgentSchema.safeParse({ modelTier: 'nope' }).success).toBe(false);
  });

  it('rejects an invalid slug (uppercase)', () => {
    const r = createAgentSchema.safeParse({
      email: 'a@b.com',
      username: 'agent',
      name: 'X',
      slug: 'Mixed-Case',
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    const r = createAgentSchema.safeParse({
      email: 'a@b.com',
      username: 'agent',
      name: 'X',
      // @ts-expect-error intentional extra field
      foo: 'bar',
    });
    expect(r.success).toBe(false);
  });

  it('caps role to contributor or editor (admins promote later)', () => {
    const r = createAgentSchema.safeParse({
      email: 'a@b.com',
      username: 'agent',
      name: 'X',
      role: 'admin' as never,
    });
    expect(r.success).toBe(false);
  });

  it('accepts both Norwegian and English description fields', () => {
    const r = createAgentSchema.safeParse({
      email: 'a@b.com',
      username: 'agent',
      name: 'Vedlikeholder',
      description: 'Norsk beskrivelse',
      descriptionEn: 'English description',
    });
    expect(r.success).toBe(true);
  });
});
