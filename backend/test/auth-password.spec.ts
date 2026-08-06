import assert from 'node:assert/strict';
import * as bcrypt from 'bcryptjs';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';

async function main() {
  const oldPassword = 'ParolaVeche!2026';
  const newPassword = 'ParolaNoua!2026';
  const user = {
    id: 17,
    tenantId: 4,
    role: 'SALES',
    email: 'utilizator@example.test',
    name: 'Utilizator Test',
    active: true,
    passwordHash: await bcrypt.hash(oldPassword, 4),
  };
  let savedHash = user.passwordHash;
  let revokedSessions = false;
  let auditPayload: Record<string, any> | undefined;

  const prisma: any = {
    user: {
      findUnique: async () => ({ ...user, passwordHash: savedHash }),
      update: async ({ data }: any) => {
        savedHash = data.passwordHash;
        return { ...user, passwordHash: savedHash };
      },
    },
    refreshToken: {
      updateMany: async ({ where, data }: any) => {
        assert.deepEqual(where, { userId: user.id, revokedAt: null });
        assert.ok(data.revokedAt instanceof Date);
        revokedSessions = true;
        return { count: 2 };
      },
      create: async ({ data }: any) => ({ id: 99, ...data }),
    },
    $transaction: async (operations: Array<Promise<unknown>>) =>
      Promise.all(operations),
  };
  const jwt: any = { signAsync: async () => 'fresh-access-token' };
  const audit: any = {
    log: async (payload: Record<string, any>) => {
      auditPayload = payload;
    },
  };
  const service = new AuthService(
    prisma,
    jwt,
    audit,
    new ConfigService({ JWT_REFRESH_TTL_DAYS: 30 }),
  );

  await assert.rejects(
    () => service.changePassword(user.id, 'parola-gresita', newPassword),
    /Parola curentă este incorectă/,
  );
  await assert.rejects(
    () => service.changePassword(user.id, oldPassword, oldPassword),
    /Parola nouă trebuie să fie diferită/,
  );

  const credentials = await service.changePassword(
    user.id,
    oldPassword,
    newPassword,
  );
  assert.equal(credentials.accessToken, 'fresh-access-token');
  assert.equal(credentials.user.id, user.id);
  assert.ok(await bcrypt.compare(newPassword, savedHash));
  assert.equal(await bcrypt.compare(oldPassword, savedHash), false);
  assert.equal(revokedSessions, true);
  assert.deepEqual(auditPayload, {
    tenantId: user.tenantId,
    userId: user.id,
    action: 'user.password_changed',
    entity: 'User',
    entityId: user.id,
    details: { selfService: true },
  });
  assert.equal(JSON.stringify(auditPayload).includes(newPassword), false);

  const resetPassword = 'ResetataDeAdmin!2026';
  let resetHash = '';
  let resetSessions = false;
  let resetAudit: Record<string, any> | undefined;
  const targetUser = {
    id: 23,
    tenantId: user.tenantId,
    email: 'coleg@example.test',
    name: 'Coleg Test',
    role: 'SALES',
    active: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  const usersService = new UsersService(
    {
      user: {
        findFirst: async () => targetUser,
        count: async () => 2,
      },
      $transaction: async (callback: (transaction: any) => Promise<any>) =>
        callback({
          user: {
            update: async ({ data }: any) => {
              resetHash = data.passwordHash;
              return targetUser;
            },
          },
          refreshToken: {
            updateMany: async ({ where, data }: any) => {
              assert.deepEqual(where, {
                userId: targetUser.id,
                revokedAt: null,
              });
              assert.ok(data.revokedAt instanceof Date);
              resetSessions = true;
              return { count: 1 };
            },
          },
        }),
    } as any,
    {
      log: async (payload: Record<string, any>) => {
        resetAudit = payload;
      },
    } as any,
  );
  await usersService.update(user.tenantId, user.id, targetUser.id, {
    password: resetPassword,
  });
  assert.ok(await bcrypt.compare(resetPassword, resetHash));
  assert.equal(resetSessions, true);
  assert.deepEqual(resetAudit?.details, {
    role: undefined,
    active: undefined,
    passwordChanged: true,
  });
  assert.equal(JSON.stringify(resetAudit).includes(resetPassword), false);

  console.log('auth-password.spec.ts passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
