import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useAutomations(boardId: string | undefined) {
  const {
    data: automations = [],
    isLoading: loading,
    refetch,
  } = useQuery({
    queryKey: ["automations", boardId],
    queryFn: () => api.automations.list(boardId!),
    enabled: !!boardId,
    refetchInterval: 30_000,
  });

  return { automations, loading, refresh: refetch };
}

export function useAutomationEvents(boardId: string | undefined, automationId: string | undefined, status: string | undefined) {
  const {
    data = { data: [], pagination: {} },
    isLoading: loading,
    refetch,
  } = useQuery({
    queryKey: ["automation-events", boardId, automationId, status],
    queryFn: () => api.automations.events(boardId!, automationId!, { status: status || undefined, limit: 100 }),
    enabled: !!boardId && !!automationId,
    refetchInterval: 30_000,
  });

  return { events: data.data, pagination: data.pagination, loading, refresh: refetch };
}

export function useCreateAutomation(boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name?: string; repository_id: string; agent_id: string; enabled?: boolean; rules?: string[] }) =>
      api.automations.create(boardId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["automations", boardId] });
    },
  });
}

export function useUpdateAutomation(boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ automationId, body }: { automationId: string; body: { name?: string; enabled?: boolean; rules?: string[] } }) =>
      api.automations.update(boardId, automationId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["automations", boardId] });
    },
  });
}

export function useDeleteAutomation(boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (automationId: string) => api.automations.delete(boardId, automationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["automations", boardId] });
    },
  });
}
