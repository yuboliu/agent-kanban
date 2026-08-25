import type { CreateSkillInput } from "@agent-kanban/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useSkills() {
  const {
    data: skills = [],
    isLoading: loading,
    refetch,
  } = useQuery({
    queryKey: ["skills"],
    queryFn: () => api.skills.list(),
  });

  return { skills, loading, refresh: refetch };
}

export function useBuiltinSkills(enabled = true) {
  const {
    data: builtin = [],
    isLoading: loading,
    refetch,
  } = useQuery({
    queryKey: ["skills", "builtin"],
    queryFn: () => api.skills.listBuiltin(),
    enabled,
  });

  return { builtin, loading, refresh: refetch };
}

export function useCreateSkill() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateSkillInput) => api.skills.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
}

export function useUpdateSkill() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; description?: string; body?: string }) => api.skills.update(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
}

export function useDeleteSkill() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.skills.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
}
