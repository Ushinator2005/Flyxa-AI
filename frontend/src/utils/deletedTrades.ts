import useFlyxaStore from '../store/flyxaStore.js';

export function persistDeletedTradeId(id: string): void {
  useFlyxaStore.getState().addDeletedTradeId(id);
}
