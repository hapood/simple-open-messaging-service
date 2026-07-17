import { Module } from '@nestjs/common';
import { join } from 'node:path';
import { ShellService, SHELL_DIR } from './shell.service.js';

/**
 * Provides `ShellService` app-wide (exported so `ShellController` — registered on `AppModule`, per
 * this project's "all controllers in AppModule" convention — can inject it). The controller lives in
 * `AppModule.controllers`, matching `ConfigController` / `HealthController`; this module owns only the
 * service.
 *
 * `SHELL_DIR` is the on-disk shell-artifacts dir; provided here (not hardcoded in the service) so the
 * e2e harness can override it with a temp dir for hermetic manifest/bundle route tests.
 */
@Module({
  providers: [
    { provide: SHELL_DIR, useValue: join(process.cwd(), 'data', 'shell') },
    ShellService,
  ],
  exports: [ShellService],
})
export class ShellModule {}
