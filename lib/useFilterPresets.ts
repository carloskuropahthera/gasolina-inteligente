'use client';
import { useState, useCallback } from 'react';
import type { AppFilters } from './types';

const STORAGE_KEY = 'gi_filter_presets_v1';

export interface FilterPreset {
  name: string;
  filters: AppFilters;
}

function readPresets(): FilterPreset[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as FilterPreset[];
  } catch {
    return [];
  }
}

function writePresets(presets: FilterPreset[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch { /* storage full */ }
}

export function useFilterPresets() {
  const [presets, setPresets] = useState<FilterPreset[]>(() => {
    if (typeof window === 'undefined') return [];
    return readPresets();
  });

  const savePreset = useCallback((name: string, filters: AppFilters) => {
    setPresets(prev => {
      const next = [{ name, filters }, ...prev.filter(p => p.name !== name)].slice(0, 10);
      writePresets(next);
      return next;
    });
  }, []);

  const deletePreset = useCallback((name: string) => {
    setPresets(prev => {
      const next = prev.filter(p => p.name !== name);
      writePresets(next);
      return next;
    });
  }, []);

  return { presets, savePreset, deletePreset };
}
