import assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { AccountingController } from '../src/accounting/accounting.controller';
import { ContractsController } from '../src/contracts/contracts.controller';
import { DocumentsController } from '../src/documents/documents.controller';
import { EtransportController } from '../src/etransport/etransport.controller';
import { PartiesController } from '../src/parties/parties.controller';
import { SagaController } from '../src/saga/saga.controller';
import { UsersController } from '../src/users/users.controller';
import { VehiclesController } from '../src/vehicles/vehicles.controller';
import { ROLES_KEY } from '../src/auth/guards';

const allowedRoles = ['ACCOUNTANT', 'SALES', 'VIEWER'];
assert.deepEqual(Object.values(Role).sort(), [...allowedRoles].sort());

const controllers = [
  AccountingController,
  ContractsController,
  DocumentsController,
  EtransportController,
  PartiesController,
  SagaController,
  UsersController,
  VehiclesController,
];

for (const controller of controllers) {
  for (const method of Object.getOwnPropertyNames(controller.prototype)) {
    const handler = controller.prototype[method];
    if (typeof handler !== 'function') continue;
    const roles = Reflect.getMetadata(ROLES_KEY, handler) as string[] | undefined;
    for (const role of roles ?? []) {
      assert.ok(
        allowedRoles.includes(role),
        `${controller.name}.${method} still uses unsupported role ${role}`,
      );
    }
  }
}

assertRoles(SagaController, 'exportZip', ['ACCOUNTANT']);
assertRoles(DocumentsController, 'upload', ['ACCOUNTANT', 'SALES']);
assertRoles(DocumentsController, 'approve', ['ACCOUNTANT']);
assertRoles(DocumentsController, 'remove', ['ACCOUNTANT']);
assertRoles(VehiclesController, 'create', ['ACCOUNTANT', 'SALES']);
assertRoles(VehiclesController, 'addCost', ['ACCOUNTANT']);
assertRoles(ContractsController, 'generate', ['ACCOUNTANT', 'SALES']);
assertRoles(ContractsController, 'regenerate', ['ACCOUNTANT', 'SALES']);
assertRoles(ContractsController, 'updateTemplates', ['ACCOUNTANT']);
assertRoles(ContractsController, 'previewTemplate', ['ACCOUNTANT']);
assertRoles(UsersController, 'list', ['ACCOUNTANT']);
assertRoles(UsersController, 'create', ['ACCOUNTANT']);
assertRoles(UsersController, 'update', ['ACCOUNTANT']);

console.log('roles.spec.ts passed');

function assertRoles(
  controller: { prototype: Record<string, any> },
  method: string,
  expected: string[],
) {
  assert.deepEqual(
    Reflect.getMetadata(ROLES_KEY, controller.prototype[method]),
    expected,
  );
}
