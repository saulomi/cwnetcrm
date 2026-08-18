// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useChannels } from './use-channels';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe('useChannels', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('starts loading with channels null, then resolves', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        channels: [
          { id: 'ch-1', account_id: 'acc-1', provider: 'meta', label: 'Sales', status: 'connected', is_default: true, created_at: '', updated_at: '' },
        ],
      }),
    });
    const { result } = renderHook(() => useChannels());
    expect(result.current.loading).toBe(true);
    expect(result.current.channels).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.channels).toHaveLength(1);
    expect(result.current.channels?.[0].id).toBe('ch-1');
  });

  it('resolves to an empty array on a failed request rather than staying null', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
    const { result } = renderHook(() => useChannels());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.channels).toEqual([]);
  });

  it('reload() re-fetches', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ channels: [] }),
    });
    const { result } = renderHook(() => useChannels());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    result.current.reload();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });
});
