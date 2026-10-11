/**
 * @file Data Worker module entrypoint (`ignite-crm-data`). The default export is the grouped
 *   {@link DataEntrypoint}, which the Application Worker's `DATA_SERVICE` service binding targets.
 */

import { DataEntrypoint } from './entrypoint.ts';

export { DataEntrypoint };
export default DataEntrypoint;
