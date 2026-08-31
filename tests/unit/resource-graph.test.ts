import { ResourceGraphService } from '@/services/resource-graph';

const resourcesMock = vi.fn();

vi.mock('@azure/arm-resourcegraph', () => ({
  ResourceGraphClient: vi.fn(function () {
    return { resources: resourcesMock };
  }),
}));

const azureClient = {
  getCredential: vi.fn(() => ({})),
  executeWithRetry: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
};

describe('ResourceGraphService', () => {
  beforeEach(() => {
    resourcesMock.mockReset();
    azureClient.executeWithRetry.mockClear();
  });

  it('returns a map of confirmed creation times keyed by lowercased resource id', async () => {
    resourcesMock.mockResolvedValue({
      data: [
        { id: '/subscriptions/sub/resourceGroups/RG-A/providers/Microsoft.Compute/virtualMachines/VM-A', createdTime: '2024-01-01T00:00:00Z' },
      ],
    });

    const service = new ResourceGraphService(azureClient as never);
    const result = await service.getCreationTimes('sub');

    expect(result.get('/subscriptions/sub/resourcegroups/rg-a/providers/microsoft.compute/virtualmachines/vm-a')).toBe(
      '2024-01-01T00:00:00Z',
    );
  });

  it('skips rows missing an id or a creation time', async () => {
    resourcesMock.mockResolvedValue({
      data: [{ id: undefined, createdTime: '2024-01-01T00:00:00Z' }, { id: '/subscriptions/sub/x', createdTime: undefined }],
    });

    const service = new ResourceGraphService(azureClient as never);
    const result = await service.getCreationTimes('sub');

    expect(result.size).toBe(0);
  });

  it('degrades to an empty map instead of throwing when the query fails', async () => {
    resourcesMock.mockRejectedValue(new Error('Forbidden'));

    const service = new ResourceGraphService(azureClient as never);
    const result = await service.getCreationTimes('sub');

    expect(result.size).toBe(0);
  });
});
