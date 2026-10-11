/**
 * @file Combine the contacts and sales services into the one `crm` module group of the Data Worker
 *   contract. Each method is listed explicitly, so adding an operation to either port without
 *   exposing it here fails the type check.
 */

import type { ContactsPort, CrmPort, SalesPort } from '../../../shared/data-service/contract.ts';

/**
 * Build the CRM module from its two services.
 *
 * @param contacts Contacts and companies.
 * @param sales Pipeline, deals, activities, next actions, and reports.
 * @returns The combined port.
 */
export function crmModule(contacts: ContactsPort, sales: SalesPort): CrmPort {
  return {
    dashboard: (actor) => contacts.dashboard(actor),
    listContacts: (actor, options) => contacts.listContacts(actor, options),
    getContact: (actor, id) => contacts.getContact(actor, id),
    createContact: (actor, input, meta) => contacts.createContact(actor, input, meta),
    updateContact: (actor, id, input, version, meta) =>
      contacts.updateContact(actor, id, input, version, meta),
    listCompanies: (actor, options) => contacts.listCompanies(actor, options),
    getCompany: (actor, id) => contacts.getCompany(actor, id),
    createCompany: (actor, input, meta) => contacts.createCompany(actor, input, meta),
    updateCompany: (actor, id, input, version, meta) =>
      contacts.updateCompany(actor, id, input, version, meta),
    getPipeline: (actor) => sales.getPipeline(actor),
    listAssignees: (actor) => sales.listAssignees(actor),
    listDeals: (actor, options) => sales.listDeals(actor, options),
    getDeal: (actor, id) => sales.getDeal(actor, id),
    createDeal: (actor, input, meta) => sales.createDeal(actor, input, meta),
    updateDeal: (actor, id, input, version, meta) =>
      sales.updateDeal(actor, id, input, version, meta),
    createActivity: (actor, input, meta) => sales.createActivity(actor, input, meta),
    setContactNextAction: (actor, contactId, input, version, meta) =>
      sales.setContactNextAction(actor, contactId, input, version, meta),
    completeContactNextAction: (actor, contactId, version, meta) =>
      sales.completeContactNextAction(actor, contactId, version, meta),
    actionStream: (actor) => sales.actionStream(actor),
    pipelineSummary: (actor) => sales.pipelineSummary(actor),
    pipelineReport: (actor, filter) => sales.pipelineReport(actor, filter),
    quarterlyPipeline: (actor, filter) => sales.quarterlyPipeline(actor, filter)
  };
}
