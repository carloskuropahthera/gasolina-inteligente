'use client';
import { useState, useEffect, useCallback } from 'react';
import type { FuelType, PriceReport } from './types';

const LS_KEY = 'gi_reports_v1';

function load(): PriceReport[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function save(reports: PriceReport[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(reports)); } catch { /* storage full */ }
}

export function useReports() {
  const [reports, setReports] = useState<PriceReport[]>([]);

  useEffect(() => { setReports(load()); }, []);

  const addReport = useCallback((report: PriceReport) => {
    setReports(prev => {
      const next = [report, ...prev].slice(0, 200); // keep last 200
      save(next);
      return next;
    });
  }, []);

  const getStationReports = useCallback(
    (stationId: string, fuelType: FuelType) =>
      reports.filter(r => r.stationId === stationId && r.fuelType === fuelType),
    [reports]
  );

  return { reports, addReport, getStationReports };
}
