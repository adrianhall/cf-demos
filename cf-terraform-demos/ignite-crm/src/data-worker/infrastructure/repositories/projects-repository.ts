/**
 * @file D1 adapter for the projects use cases. All SQL is constant text with bound parameters. A
 *   project row is joined to its source deal, company, contact, and lead, plus its live task
 *   counts, in one statement; a task row is joined to its project, assignee, and creator. A board
 *   or worklist therefore costs one query however many tasks it shows. The conversion write set
 *   (see `../../application/projects/projects-service.ts`) is the architectural centrepiece: its
 *   guards, project insert, conversion record, deal back-link, audit, and idempotency rows all run
 *   in one `batch()`, so any failure rolls back every row.
 */

import type { UserRef } from '../../../shared/api/crm.ts';
import type {
  Project,
  ProjectDetail,
  ProjectStatus,
  Task,
  TaskPriority,
  TaskStatus
} from '../../../shared/api/projects.ts';
import type { DealStatus } from '../../../shared/api/sales.ts';
import type {
  ConvertibleDeal,
  DeliveryRow,
  ProjectRow,
  ProjectsRepository,
  TaskRow
} from '../../application/projects/projects-service.ts';
import type { MutationEnvelope } from '../../application/shared/mutations.ts';
import type { ListCriteria } from '../../application/shared/paging.ts';
import { likeContains } from '../../domain/crm/contacts.ts';
import { type D1Port, type D1TransactionPort, sql, type SqlValue } from '../d1/d1-port.ts';
import { D1IdempotencyReader, writeEnvelope } from './envelope.ts';

/**
 * Row shape of a project projection.
 */
interface ProjectProjectionRow {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  deal_id: string | null;
  deal_title: string | null;
  company_id: string | null;
  company_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
  lead_id: string;
  lead_name: string;
  target_date: string | null;
  todo: number;
  in_progress: number;
  in_review: number;
  done: number;
  version: number;
  created_at: string;
  updated_at: string;
  sort_key: string;
}

/**
 * The project projection: one row per project with every reference and its task counts.
 */
const PROJECT_SELECT = `
  SELECT p.id, p.name, p.description, p.status,
         d.id AS deal_id, d.title AS deal_title,
         co.id AS company_id, co.name AS company_name,
         ct.id AS contact_id, ct.display_name AS contact_name,
         u.id AS lead_id, u.display_name AS lead_name,
         p.target_date,
         (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.status = 'todo') AS todo,
         (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.status = 'in_progress') AS in_progress,
         (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.status = 'in_review') AS in_review,
         (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.status = 'done') AS done,
         p.version, p.created_at, p.updated_at, lower(p.name) AS sort_key
    FROM projects p
    JOIN users u ON u.id = p.lead_id
    LEFT JOIN deals d ON d.id = p.source_deal_id
    LEFT JOIN companies co ON co.id = p.company_id
    LEFT JOIN contacts ct ON ct.id = p.primary_contact_id
   WHERE p.deleted_at IS NULL`;

/**
 * Map a project projection row.
 *
 * @param row The row.
 * @returns The project.
 */
function toProject(row: ProjectProjectionRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    sourceDeal:
      row.deal_id !== null && row.deal_title !== null
        ? { id: row.deal_id, title: row.deal_title }
        : null,
    company:
      row.company_id !== null && row.company_name !== null
        ? { id: row.company_id, name: row.company_name }
        : null,
    primaryContact:
      row.contact_id !== null && row.contact_name !== null
        ? { id: row.contact_id, displayName: row.contact_name }
        : null,
    lead: { id: row.lead_id, displayName: row.lead_name },
    targetDate: row.target_date,
    taskCounts: {
      todo: row.todo,
      in_progress: row.in_progress,
      in_review: row.in_review,
      done: row.done
    },
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Row shape of a task projection.
 */
interface TaskProjectionRow {
  id: string;
  project_id: string;
  project_name: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assignee_id: string | null;
  assignee_name: string | null;
  due_date: string | null;
  position: number;
  creator_id: string;
  creator_name: string;
  completed_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

/**
 * The task projection; callers append filters and ordering.
 */
const TASK_SELECT = `
  SELECT t.id, p.id AS project_id, p.name AS project_name, t.title, t.description, t.status,
         t.priority, a.id AS assignee_id, a.display_name AS assignee_name, t.due_date, t.position,
         c.id AS creator_id, c.display_name AS creator_name, t.completed_at, t.version,
         t.created_at, t.updated_at
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN users c ON c.id = t.created_by
    LEFT JOIN users a ON a.id = t.assignee_id
   WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL`;

/**
 * Board order: status column, then position, then id.
 */
const BOARD_ORDER = `
  ORDER BY CASE t.status WHEN 'todo' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'in_review' THEN 2 ELSE 3 END,
           t.position, t.id`;

/**
 * Map a task projection row.
 *
 * @param row The row.
 * @returns The task.
 */
function toTask(row: TaskProjectionRow): Task {
  return {
    id: row.id,
    project: { id: row.project_id, name: row.project_name },
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assignee:
      row.assignee_id !== null && row.assignee_name !== null
        ? { id: row.assignee_id, displayName: row.assignee_name }
        : null,
    dueDate: row.due_date,
    position: row.position,
    createdBy: { id: row.creator_id, displayName: row.creator_name },
    completedAt: row.completed_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Queue a guard that a user is still active at commit time.
 *
 * @param tx The open transaction.
 * @param userId The user.
 */
function guardActiveUser(tx: D1TransactionPort, userId: string): void {
  tx.requireRow(
    sql("SELECT count(*) FROM users WHERE id = ? AND status = 'active'", userId),
    'NOT_FOUND'
  );
}

/**
 * Queue a guard that a project still exists and is not archived at commit time.
 *
 * @param tx The open transaction.
 * @param projectId The project.
 */
function guardWritableProject(tx: D1TransactionPort, projectId: string): void {
  tx.requireRow(
    sql(
      "SELECT count(*) FROM projects WHERE id = ? AND deleted_at IS NULL AND status <> 'archived'",
      projectId
    ),
    'CONFLICT'
  );
}

/**
 * {@link ProjectsRepository} over D1.
 */
export class D1ProjectsRepository extends D1IdempotencyReader implements ProjectsRepository {
  /**
   * @param port The D1 port.
   */
  constructor(private readonly port: D1Port) {
    super(port);
  }

  /**
   * @inheritdoc
   */
  async activeUser(userId: string): Promise<UserRef | null> {
    const row = await this.port.readOne<{ id: string; display_name: string }>(
      sql("SELECT id, display_name FROM users WHERE id = ? AND status = 'active'", userId)
    );
    return row === null ? null : { id: row.id, displayName: row.display_name };
  }

  /**
   * @inheritdoc
   */
  async convertibleDeal(dealId: string): Promise<ConvertibleDeal | null> {
    const row = await this.port.readOne<{
      id: string;
      title: string;
      status: DealStatus;
      project_id: string | null;
      version: number;
      company_id: string | null;
      company_name: string | null;
      contact_id: string;
      contact_name: string;
    }>(
      sql(
        `SELECT d.id, d.title, d.status, d.project_id, d.version,
                co.id AS company_id, co.name AS company_name,
                ct.id AS contact_id, ct.display_name AS contact_name
           FROM deals d
           JOIN contacts ct ON ct.id = d.primary_contact_id
           LEFT JOIN companies co ON co.id = d.company_id AND co.deleted_at IS NULL
          WHERE d.id = ? AND d.deleted_at IS NULL`,
        dealId
      )
    );
    return row === null
      ? null
      : {
          id: row.id,
          title: row.title,
          status: row.status,
          projectId: row.project_id,
          version: row.version,
          company:
            row.company_id !== null && row.company_name !== null
              ? { id: row.company_id, name: row.company_name }
              : null,
          primaryContact: { id: row.contact_id, displayName: row.contact_name }
        };
  }

  /**
   * @inheritdoc
   */
  async listProjects(
    criteria: ListCriteria,
    status: ProjectStatus | null
  ): Promise<Array<Project & { sortKey: string }>> {
    let text = PROJECT_SELECT;
    const params: SqlValue[] = [];
    if (status !== null) {
      text += ' AND p.status = ?';
      params.push(status);
    }
    if (criteria.q !== null) {
      text += ` AND (lower(p.name) LIKE ? ESCAPE '\\' OR lower(coalesce(co.name, '')) LIKE ? ESCAPE '\\'
                     OR lower(coalesce(ct.display_name, '')) LIKE ? ESCAPE '\\')`;
      const pattern = likeContains(criteria.q);
      params.push(pattern, pattern, pattern);
    }
    if (criteria.after !== null) {
      text += ' AND (lower(p.name) > ? OR (lower(p.name) = ? AND p.id > ?))';
      params.push(criteria.after.key, criteria.after.key, criteria.after.id);
    }
    text += ' ORDER BY lower(p.name), p.id LIMIT ?';
    params.push(criteria.limit + 1);
    const rows = await this.port.read<ProjectProjectionRow>(sql(text, ...params));
    return rows.map((row) => ({ ...toProject(row), sortKey: row.sort_key }));
  }

  /**
   * @inheritdoc
   */
  async getProject(id: string): Promise<Project | null> {
    const row = await this.port.readOne<ProjectProjectionRow>(
      sql(`${PROJECT_SELECT} AND p.id = ?`, id)
    );
    return row === null ? null : toProject(row);
  }

  /**
   * @inheritdoc
   */
  async contactProjects(contactId: string, limit: number): Promise<Project[]> {
    const rows = await this.port.read<ProjectProjectionRow>(
      sql(
        `${PROJECT_SELECT} AND p.primary_contact_id = ? ORDER BY p.created_at DESC, p.id LIMIT ?`,
        contactId,
        limit
      )
    );
    return rows.map(toProject);
  }

  /**
   * @inheritdoc
   */
  async companyProjects(companyId: string, limit: number): Promise<Project[]> {
    const rows = await this.port.read<ProjectProjectionRow>(
      sql(
        `${PROJECT_SELECT} AND p.company_id = ? ORDER BY p.created_at DESC, p.id LIMIT ?`,
        companyId,
        limit
      )
    );
    return rows.map(toProject);
  }

  /**
   * @inheritdoc
   */
  async projectTasks(projectId: string, limit: number): Promise<Task[]> {
    const rows = await this.port.read<TaskProjectionRow>(
      sql(`${TASK_SELECT} AND t.project_id = ? ${BOARD_ORDER} LIMIT ?`, projectId, limit)
    );
    return rows.map(toTask);
  }

  /**
   * @inheritdoc
   */
  async getTask(id: string): Promise<Task | null> {
    const row = await this.port.readOne<TaskProjectionRow>(sql(`${TASK_SELECT} AND t.id = ?`, id));
    return row === null ? null : toTask(row);
  }

  /**
   * @inheritdoc
   */
  async lastPosition(projectId: string, status: TaskStatus): Promise<number | null> {
    const row = await this.port.readOne<{ last: number | null }>(
      sql(
        `SELECT max(position) AS last FROM tasks
          WHERE project_id = ? AND status = ? AND deleted_at IS NULL`,
        projectId,
        status
      )
    );
    return row?.last ?? null;
  }

  /**
   * @inheritdoc
   */
  async deliveryRows(
    filter: { readonly status: ProjectStatus; readonly leadId: string | null },
    today: string
  ): Promise<DeliveryRow[]> {
    // One grouped pass over tasks per project (index `tasks_board` covers project_id + status).
    const rows = await this.port.read<{
      id: string;
      name: string;
      lead_id: string;
      lead_name: string;
      target_date: string | null;
      todo: number;
      in_progress: number;
      in_review: number;
      done: number;
      overdue: number;
    }>(
      sql(
        `SELECT p.id, p.name, u.id AS lead_id, u.display_name AS lead_name, p.target_date,
                coalesce(sum(t.status = 'todo'), 0) AS todo,
                coalesce(sum(t.status = 'in_progress'), 0) AS in_progress,
                coalesce(sum(t.status = 'in_review'), 0) AS in_review,
                coalesce(sum(t.status = 'done'), 0) AS done,
                coalesce(sum(t.status <> 'done' AND t.due_date < ?), 0) AS overdue
           FROM projects p
           JOIN users u ON u.id = p.lead_id
           LEFT JOIN tasks t ON t.project_id = p.id AND t.deleted_at IS NULL
          WHERE p.deleted_at IS NULL AND p.status = ? AND (? IS NULL OR p.lead_id = ?)
          GROUP BY p.id
          ORDER BY (todo + in_progress + in_review) DESC, overdue DESC, lower(p.name), p.id`,
        today,
        filter.status,
        filter.leadId,
        filter.leadId
      )
    );
    return rows.map((row) => ({
      project: { id: row.id, name: row.name },
      lead: { id: row.lead_id, displayName: row.lead_name },
      targetDate: row.target_date,
      taskCounts: {
        todo: row.todo,
        in_progress: row.in_progress,
        in_review: row.in_review,
        done: row.done
      },
      overdue: row.overdue
    }));
  }

  /**
   * @inheritdoc
   */
  async userRef(userId: string): Promise<UserRef | null> {
    const row = await this.port.readOne<{ id: string; display_name: string }>(
      sql('SELECT id, display_name FROM users WHERE id = ?', userId)
    );
    return row === null ? null : { id: row.id, displayName: row.display_name };
  }

  /**
   * @inheritdoc
   */
  async myWork(userId: string, limit: number): Promise<Task[]> {
    // Dated tasks first by date (so overdue lead), then undated; within a day, most urgent first.
    const rows = await this.port.read<TaskProjectionRow>(
      sql(
        `${TASK_SELECT} AND t.assignee_id = ? AND t.status <> 'done' AND p.status <> 'archived'
          ORDER BY t.due_date IS NULL, t.due_date,
                   CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
                                   WHEN 'low' THEN 3 ELSE 4 END,
                   t.id
          LIMIT ?`,
        userId,
        limit
      )
    );
    return rows.map(toTask);
  }

  /**
   * @inheritdoc
   */
  async history(
    entityType: string,
    entityId: string,
    limit: number
  ): Promise<ProjectDetail['history']> {
    const rows = await this.port.read<{
      id: string;
      action: string;
      actor_id: string;
      actor_name: string;
      occurred_at: string;
    }>(
      sql(
        `SELECT a.id, a.action, a.actor_id, u.display_name AS actor_name, a.occurred_at
           FROM audit_events a JOIN users u ON u.id = a.actor_id
          WHERE a.entity_type = ? AND a.entity_id = ?
          ORDER BY a.occurred_at DESC, a.id LIMIT ?`,
        entityType,
        entityId,
        limit
      )
    );
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      actor: { id: row.actor_id, displayName: row.actor_name },
      occurredAt: row.occurred_at
    }));
  }

  /**
   * @inheritdoc
   */
  async convert(write: {
    project: ProjectRow;
    expectedDealVersion: number;
    markWon: boolean;
    at: string;
    envelope: MutationEnvelope;
  }): Promise<void> {
    const { project } = write;
    const dealId = project.sourceDealId;
    await this.port.transaction((tx) => {
      guardActiveUser(tx, project.leadId);
      tx.write(
        sql(
          `INSERT INTO projects
             (id, name, description, status, source_deal_id, company_id, primary_contact_id,
              lead_id, target_date, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          project.id,
          project.name,
          project.description,
          project.status,
          dealId,
          project.companyId,
          project.primaryContactId,
          project.leadId,
          project.targetDate,
          write.at,
          write.at
        )
      );
      tx.write(
        sql(
          `INSERT INTO conversion_attempts (source_deal_id, project_id, actor_id, state, created_at)
           VALUES (?, ?, ?, 'completed', ?)`,
          dealId,
          project.id,
          write.envelope.idempotency.actorId,
          write.at
        )
      );
      // The back-link is a compare-and-swap on the deal's state *and* version: if the deal was
      // reopened, edited, or converted by someone else since it was read, no row changes and the
      // guard below rolls back the project, conversion record, audit, and idempotency rows.
      // With `markWon`, the same statement closes a pending deal: it becomes won, stamps closedAt,
      // and drops the next action and expected close date, exactly as a manual "won" edit does.
      tx.write(
        write.markWon
          ? sql(
              `UPDATE deals
                  SET project_id = ?, status = 'won', closed_at = ?, next_action_text = NULL,
                      next_action_date = NULL, expected_close_date = NULL,
                      version = version + 1, updated_at = ?
                WHERE id = ? AND version = ? AND status = 'pending' AND project_id IS NULL
                  AND deleted_at IS NULL`,
              project.id,
              write.at,
              write.at,
              dealId,
              write.expectedDealVersion
            )
          : sql(
              `UPDATE deals SET project_id = ?, version = version + 1, updated_at = ?
                WHERE id = ? AND version = ? AND status = 'won' AND project_id IS NULL
                  AND deleted_at IS NULL`,
              project.id,
              write.at,
              dealId,
              write.expectedDealVersion
            )
      );
      tx.requireChanged('VERSION_MISMATCH');
      writeEnvelope(tx, write.envelope);
      return Promise.resolve();
    });
  }

  /**
   * @inheritdoc
   */
  async updateProject(write: {
    project: ProjectRow;
    expectedVersion: number;
    at: string;
    envelope: MutationEnvelope;
  }): Promise<void> {
    const { project } = write;
    await this.port.transaction((tx) => {
      guardActiveUser(tx, project.leadId);
      tx.write(
        sql(
          `UPDATE projects
              SET name = ?, description = ?, status = ?, lead_id = ?, target_date = ?,
                  version = version + 1, updated_at = ?
            WHERE id = ? AND version = ? AND deleted_at IS NULL`,
          project.name,
          project.description,
          project.status,
          project.leadId,
          project.targetDate,
          write.at,
          project.id,
          write.expectedVersion
        )
      );
      tx.requireChanged('VERSION_MISMATCH');
      writeEnvelope(tx, write.envelope);
      return Promise.resolve();
    });
  }

  /**
   * @inheritdoc
   */
  async insertTask(write: {
    task: TaskRow;
    at: string;
    envelope: MutationEnvelope;
  }): Promise<void> {
    const { task } = write;
    await this.port.transaction((tx) => {
      guardWritableProject(tx, task.projectId);
      if (task.assigneeId !== null) {
        guardActiveUser(tx, task.assigneeId);
      }
      tx.write(
        sql(
          `INSERT INTO tasks
             (id, project_id, title, description, status, priority, assignee_id, due_date,
              position, created_by, completed_at, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          task.id,
          task.projectId,
          task.title,
          task.description,
          task.status,
          task.priority,
          task.assigneeId,
          task.dueDate,
          task.position,
          task.createdBy,
          task.completedAt,
          write.at,
          write.at
        )
      );
      writeEnvelope(tx, write.envelope);
      return Promise.resolve();
    });
  }

  /**
   * @inheritdoc
   */
  async updateTask(write: {
    task: TaskRow;
    expectedVersion: number;
    at: string;
    envelope: MutationEnvelope;
  }): Promise<void> {
    const { task } = write;
    await this.port.transaction((tx) => {
      guardWritableProject(tx, task.projectId);
      if (task.assigneeId !== null) {
        guardActiveUser(tx, task.assigneeId);
      }
      tx.write(
        sql(
          `UPDATE tasks
              SET title = ?, description = ?, status = ?, priority = ?, assignee_id = ?,
                  due_date = ?, position = ?, completed_at = ?, version = version + 1,
                  updated_at = ?
            WHERE id = ? AND version = ? AND deleted_at IS NULL`,
          task.title,
          task.description,
          task.status,
          task.priority,
          task.assigneeId,
          task.dueDate,
          task.position,
          task.completedAt,
          write.at,
          task.id,
          write.expectedVersion
        )
      );
      tx.requireChanged('VERSION_MISMATCH');
      writeEnvelope(tx, write.envelope);
      return Promise.resolve();
    });
  }
}
