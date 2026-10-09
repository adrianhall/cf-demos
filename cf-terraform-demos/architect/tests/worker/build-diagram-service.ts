import { CollaboratorService } from '../../src/worker/application/collaborator-service.ts';
import { DiagramService } from '../../src/worker/application/diagram-service.ts';
import type { DiagramSessionPort } from '../../src/worker/application/ports/diagram-session.ts';
import type { ShareRepository } from '../../src/worker/application/ports/share-repository.ts';
import { FakeCollaboratorRepository } from './fake-collaborator-repository.ts';
import type { FakeDiagramRepository } from './fake-diagram-repository.ts';
import { FakeDiagramSessions } from './fake-diagram-sessions.ts';
import { FakeShareRepository } from './fake-share-repository.ts';
import { FakeUserRepository } from './fake-user-repository.ts';

/**
 * @file Assembles a {@link DiagramService} the way `src/worker/index.ts` does, for the suites that
 *   need one. It exists because the diagram service is given its widened access rule rather than
 *   implementing it: a suite that stubbed that rule instead of supplying the real
 *   {@link CollaboratorService} would be asserting the ownership behaviour of a service wired
 *   differently from the deployed one, which is precisely the kind of test that keeps passing while
 *   the product is wrong.
 */

/**
 * The fakes a suite may want to reach into after exercising the service.
 */
export interface BuiltDiagramService {
  /**
   * The assembled diagram service, wired to the real collaborator rule.
   */
  service: DiagramService;
  /**
   * The collaboration use cases built alongside it, sharing the same repositories, so a suite can
   * grant access and then observe what the diagram service does about it.
   */
  collaborators: CollaboratorService;
  /**
   * The grant store, for a suite that needs to seed or inspect one directly.
   */
  collaboratorRows: FakeCollaboratorRepository;
  /**
   * The directory, whose rows decide which emails may be added as collaborators.
   */
  users: FakeUserRepository;
}

/**
 * Builds a diagram service over the supplied diagram store, with real collaboration wiring.
 *
 * @param diagrams Diagram store the service and the collaboration rule both read.
 * @param shares Share port, defaulting to an empty in-memory one for a suite that does not care.
 * @param sessions Live-session port, defaulting to a recording in-memory one.
 * @returns The service and the collaboration pieces built with it; see {@link BuiltDiagramService}.
 */
export function buildDiagramService(
  diagrams: FakeDiagramRepository,
  shares: ShareRepository = new FakeShareRepository(),
  sessions: DiagramSessionPort = new FakeDiagramSessions()
): BuiltDiagramService {
  const collaboratorRows = new FakeCollaboratorRepository(diagrams);
  const users = new FakeUserRepository(diagrams);
  const collaborators = new CollaboratorService(collaboratorRows, diagrams, users);

  return {
    collaboratorRows,
    collaborators,
    service: new DiagramService(diagrams, shares, sessions, collaborators),
    users
  };
}
