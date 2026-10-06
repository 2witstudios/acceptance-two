import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { slotEnvValues, withSlotEnv } from './slot-env';
import { cloneSlotId } from './slot-ownership';
import {
  resetEnvRefusal,
  resetRefusal,
  serviceRefusal,
  slotMismatches,
  worktreeSlot,
} from './slot-model';

setupRitewayBun();

describe('reset scope', () => {
  const slot = worktreeSlot('abc');
  const allowed = { NODE_ENV: 'development', ALLOW_DATABASE_RESET: 'yes' };

  test('accepts only the current slot databases on loopback', () => {
    assert({
      given: 'reset targets inside and outside this slot',
      should:
        'accept the slot dev and test databases and refuse the rest, including the e2e database slot:reset-e2e owns',
      actual: [
        resetRefusal(slot, {
          ...allowed,
          DATABASE_URL: 'postgres://d:p@localhost:15432/acceptance_two_wt_abc',
        }),
        resetRefusal(slot, {
          ...allowed,
          DATABASE_URL:
            'postgres://d:p@127.0.0.1:15432/acceptance_two_wt_abc_test',
        }),
        resetRefusal(slot, {
          ...allowed,
          DATABASE_URL:
            'postgres://d:p@localhost:15432/acceptance_two_wt_abc_e2e',
        }),
        resetRefusal(slot, {
          ...allowed,
          DATABASE_URL: 'postgres://d:p@localhost:15432/acceptance_two_test',
        }),
        resetRefusal(slot, {
          ...allowed,
          DATABASE_URL:
            'postgres://d:p@db.example.com:5432/acceptance_two_wt_abc',
        }),
        resetRefusal(slot, {
          NODE_ENV: 'development',
          DATABASE_URL: 'postgres://d:p@localhost:15432/acceptance_two_wt_abc',
        }),
        resetRefusal(slot, {
          ...allowed,
          NODE_ENV: 'production',
          DATABASE_URL: 'postgres://d:p@localhost:15432/acceptance_two_wt_abc',
        }),
      ].map((refusal) => refusal === undefined),
      expected: [true, true, false, false, false, false, false],
    });
  });

  test('refuses before connecting, and refuses a clone the main databases', () => {
    const mainUrl = 'postgres://d:p@localhost:15432/acceptance_two';
    assert({
      given:
        'environments checked before any connection, and a clone whose .env still names main',
      should:
        'refuse production, an unset flag and a remote host up front, and refuse the clone the main database',
      actual: [
        resetEnvRefusal({ ...allowed, DATABASE_URL: mainUrl }),
        resetEnvRefusal({ ...allowed, NODE_ENV: 'production' }),
        resetEnvRefusal({ NODE_ENV: 'development', DATABASE_URL: mainUrl }),
        resetEnvRefusal({
          ...allowed,
          DATABASE_URL: 'postgres://d:p@db.example.com:5432/acceptance_two',
        }),
        resetRefusal(worktreeSlot(cloneSlotId('/tmp/review/acceptance-two')), {
          ...allowed,
          DATABASE_URL: mainUrl,
        }),
      ].map((refusal) => refusal === undefined),
      expected: [true, false, false, false, false],
    });
  });
});

describe('slot service scope', () => {
  const local = {
    DATABASE_URL: 'postgres://acceptance_two:pw@localhost:15432/acceptance_two',
    REDIS_URL: 'redis://127.0.0.1:6379',
  };

  test('accepts only loopback Postgres and Redis', () => {
    assert({
      given: 'slot administration URLs on loopback and elsewhere',
      should: 'accept the local stack and refuse any other host',
      actual: [
        serviceRefusal(local),
        serviceRefusal({ ...local, E2E_REDIS_URL: 'redis://[::1]:6379/2' }),
        serviceRefusal({
          ...local,
          DATABASE_URL:
            'postgres://acceptance_two:pw@db.example.com:5432/acceptance_two',
        }),
        serviceRefusal({ ...local, REDIS_URL: 'rediss://cache.example.com' }),
        serviceRefusal({
          ...local,
          E2E_REDIS_URL: 'redis://10.0.0.5:6379/2',
        }),
        serviceRefusal({ REDIS_URL: local.REDIS_URL }),
        serviceRefusal({ ...local, DATABASE_URL: 'not a url' }),
        serviceRefusal({
          ...local,
          TEST_REDIS_URL: 'redis://cache.example.com:6379/1',
        }),
        serviceRefusal({
          ...local,
          TEST_REDIS_URL: 'redis://localhost:6379/3',
        }),
      ],
      expected: [
        undefined,
        undefined,
        'DATABASE_URL must name the local stack (localhost, 127.0.0.1 or ::1), not db.example.com',
        'REDIS_URL must name the local stack (localhost, 127.0.0.1 or ::1), not cache.example.com',
        'E2E_REDIS_URL must name the local stack (localhost, 127.0.0.1 or ::1), not 10.0.0.5',
        'DATABASE_URL is required in .env',
        'DATABASE_URL is not a valid URL',
        'TEST_REDIS_URL must name the local stack (localhost, 127.0.0.1 or ::1), not cache.example.com',
        undefined,
      ],
    });
  });
});

describe('one server per slot', () => {
  const slot = worktreeSlot('abc');
  const shared = 'postgres://acceptance_two:pw@localhost:15432/acceptance_two';

  test('derives every slot database URL from the DATABASE_URL server', () => {
    const values = slotEnvValues({
      slot,
      env: {
        DATABASE_URL: shared,
        TEST_DATABASE_URL:
          'postgres://acceptance_two:pw@localhost:25432/acceptance_two_test',
        REDIS_URL: 'redis://localhost:6379',
      },
      portBlock: 1,
    });
    assert({
      given: 'a TEST_DATABASE_URL left on an old per-session server',
      should: 'move the test and e2e URLs onto the DATABASE_URL server',
      actual: [values.TEST_DATABASE_URL, values.E2E_DATABASE_URL],
      expected: [
        'postgres://acceptance_two:pw@localhost:15432/acceptance_two_wt_abc_test',
        'postgres://acceptance_two_e2e:e2e-loopback-only@localhost:15432/acceptance_two_wt_abc_e2e',
      ],
    });
  });

  test('flags test or e2e URLs that name another server', () => {
    const own = {
      REDIS_URL: 'redis://localhost:6379',
      ...slotEnvValues({
        slot,
        env: { DATABASE_URL: shared, REDIS_URL: 'redis://localhost:6379' },
        portBlock: 1,
      }),
    };
    assert({
      given: 'slot URLs whose names match but whose server differs',
      should: 'name each URL on the wrong server',
      actual: slotMismatches(slot, {
        ...own,
        TEST_DATABASE_URL:
          'postgres://acceptance_two:pw@localhost:25432/acceptance_two_wt_abc_test',
      }),
      expected: [
        'TEST_DATABASE_URL is on localhost:25432, expected the DATABASE_URL server localhost:15432',
      ],
    });
  });
});

describe('child processes after slot:up', () => {
  test('see the slot values slot:up just wrote, not the ones inherited', () => {
    const inherited = {
      DATABASE_URL:
        'postgres://acceptance_two:pw@localhost:15432/acceptance_two',
      REDIS_NAMESPACE: 'acceptance-two',
      PUBLIC_APP_URL: 'http://localhost:3000',
      PATH: '/usr/bin',
      BETTER_AUTH_SECRET: 'kept',
    };
    const rewritten = [
      'DATABASE_URL=postgres://acceptance_two:pw@localhost:15432/acceptance_two_wt_abc',
      'REDIS_NAMESPACE=acceptance-two-wt-abc',
      'PUBLIC_APP_URL=http://localhost:13010',
      'BETTER_AUTH_SECRET=from-file',
      '',
    ].join('\n');
    assert({
      given: 'an environment loaded before slot:up rewrote .env',
      should: 'replace every slot value and leave everything else alone',
      actual: withSlotEnv(inherited, rewritten),
      expected: {
        DATABASE_URL:
          'postgres://acceptance_two:pw@localhost:15432/acceptance_two_wt_abc',
        REDIS_NAMESPACE: 'acceptance-two-wt-abc',
        PUBLIC_APP_URL: 'http://localhost:13010',
        PATH: '/usr/bin',
        BETTER_AUTH_SECRET: 'kept',
      },
    });
  });
});
