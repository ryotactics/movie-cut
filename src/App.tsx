import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

declare global {
  type WellKnownDirectory = 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';

  type SaveFilePickerOptions = {
    suggestedName?: string;
    startIn?: FileSystemHandle | WellKnownDirectory;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  };

  interface Window {
    FFmpeg?: {
      createFFmpeg: (options: { corePath: string; log: boolean }) => FFmpegInstance;
      fetchFile: (source: Blob | File | string) => Promise<Uint8Array>;
    };
    showSaveFilePicker?: (options: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
  }
}

type FFmpegInstance = {
  load: () => Promise<void>;
  run: (...args: string[]) => Promise<void>;
  FS: (op: 'writeFile' | 'readFile' | 'unlink', path: string, data?: Uint8Array) => Uint8Array;
  setLogger: (logger: (entry: { message: string }) => void) => void;
};

type ToastType = '' | 'success' | 'error';
type Toast = { id: number; message: string; type: ToastType; action?: { label: string; onClick: () => void }; duration?: number };
type RestorePrompt = { splitPoints: number[]; segmentNames?: Record<number, string>; excludedSegments?: number[]; selectedSegments?: number[] };
type DraggingMarker = { index: number; startX: number; startTime: number } | null;
type ProjectFile = {
  version: number;
  videoFileName?: string;
  splitPoints: number[];
  segmentNames: Record<number, string>;
  excludedSegments: number[];
  selectedSegments: number[];
};

const COLORS = ['#5b6af0', '#f05b8a', '#4caf7d', '#f9c846', '#5bc8f0', '#c85bf0', '#f08c5b', '#5bf0b8'];
const FILE_SIZE_MAX = 2 * 1024 * 1024 * 1024;
const FILE_SIZE_WARN = 500 * 1024 * 1024;
const ZOOM_LEVELS = [1, 2, 5, 10, 20];
const FFMPEG_CDN_CANDIDATES = [
  {
    script: 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js',
    core: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js',
  },
  {
    script: 'https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js',
    core: 'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js',
  },
];

function formatTime(sec: number, alwaysHours = false) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0 || alwaysHours) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function getFileKey(file: File) {
  return `moviecut:${file.name}:${file.size}:${file.lastModified}`;
}

function isVideoFile(file: File) {
  return file.type.startsWith('video/') || /\.(mp4|mov|mkv|webm|avi|m4v|ts|mts|m2ts|wmv|flv|3gp|mpg|mpeg|ogv|ogg|3g2)$/i.test(file.name);
}

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      if (window.FFmpeg) resolve();
      else existing.addEventListener('load', () => resolve(), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Script load failed: ${src}`));
    document.head.appendChild(script);
  });
}

function App() {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoMeta, setVideoMeta] = useState({ resolution: '—', filesize: '—' });
  const [splitPoints, setSplitPoints] = useState<number[]>([]);
  const [selectedSegments, setSelectedSegments] = useState<Set<number>>(new Set());
  const [excludedSegments, setExcludedSegments] = useState<Set<number>>(new Set());
  const [segmentNames, setSegmentNames] = useState<Record<number, string>>({});
  const [segmentPlayEnd, setSegmentPlayEnd] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [zoomLevel, setZoomLevelState] = useState(1);
  const [zoomStart, setZoomStartState] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [ffmpegStatus, setFfmpegStatus] = useState({ text: 'Loading…', cls: 'loading' });
  const [ffmpegReady, setFfmpegReady] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [segmentProgress, setSegmentProgress] = useState<Record<number, number>>({});
  const [globalProgress, setGlobalProgress] = useState({ active: false, label: 'Exporting… 0 / 0', pct: 0 });
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [timelineWidth, setTimelineWidth] = useState(600);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const projectInputRef = useRef<HTMLInputElement | null>(null);
  const timelineTrackRef = useRef<HTMLDivElement | null>(null);
  const ffmpegRef = useRef<FFmpegInstance | null>(null);
  const fetchFileRef = useRef<((source: Blob | File | string) => Promise<Uint8Array>) | null>(null);
  const ffmpegInputNameRef = useRef<string | null>(null);
  const savePickerStartInRef = useRef<FileSystemHandle | WellKnownDirectory>('downloads');
  const videoFileRef = useRef<File | null>(null);
  const splitPointsRef = useRef<number[]>([]);
  const selectedSegmentsRef = useRef<Set<number>>(new Set());
  const excludedSegmentsRef = useRef<Set<number>>(new Set());
  const segmentNamesRef = useRef<Record<number, string>>({});
  const segmentPlayEndRef = useRef<number | null>(null);
  const zoomLevelRef = useRef(1);
  const zoomStartRef = useRef(0);
  const videoDurationRef = useRef(0);
  const isScrubbingRef = useRef(false);
  const wasPlayingBeforeScrubRef = useRef(false);
  const pendingScrubTimeRef = useRef<number | null>(null);
  const seekBusyRef = useRef(false);
  const draggingMarkerRef = useRef<DraggingMarker>(null);
  const toastIdRef = useRef(0);

  useEffect(() => { videoFileRef.current = videoFile; }, [videoFile]);
  useEffect(() => { splitPointsRef.current = splitPoints; }, [splitPoints]);
  useEffect(() => { selectedSegmentsRef.current = selectedSegments; }, [selectedSegments]);
  useEffect(() => { excludedSegmentsRef.current = excludedSegments; }, [excludedSegments]);
  useEffect(() => { segmentNamesRef.current = segmentNames; }, [segmentNames]);
  useEffect(() => { segmentPlayEndRef.current = segmentPlayEnd; }, [segmentPlayEnd]);
  useEffect(() => { zoomLevelRef.current = zoomLevel; }, [zoomLevel]);
  useEffect(() => { zoomStartRef.current = zoomStart; }, [zoomStart]);
  useEffect(() => { videoDurationRef.current = videoDuration; }, [videoDuration]);
  useEffect(() => { isScrubbingRef.current = isScrubbing; }, [isScrubbing]);

  const showToast = useCallback((message: string, type: ToastType = '', duration = 2800, action?: Toast['action']) => {
    const id = ++toastIdRef.current;
    setToasts((items) => [...items, { id, message, type, action, duration }]);
    setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), duration);
  }, []);

  const saveAutosave = useCallback((snapshot?: Partial<{ splitPoints: number[]; segmentNames: Record<number, string>; excludedSegments: Set<number>; selectedSegments: Set<number> }>) => {
    const file = videoFileRef.current;
    if (!file) return;
    try {
      localStorage.setItem(getFileKey(file), JSON.stringify({
        version: 1,
        splitPoints: snapshot?.splitPoints ?? splitPointsRef.current,
        segmentNames: snapshot?.segmentNames ?? segmentNamesRef.current,
        excludedSegments: [...(snapshot?.excludedSegments ?? excludedSegmentsRef.current)],
        selectedSegments: [...(snapshot?.selectedSegments ?? selectedSegmentsRef.current)],
      }));
    } catch (_) {}
  }, []);

  const boundaries = useMemo(() => (videoDuration ? [0, ...splitPoints, videoDuration] : []), [splitPoints, videoDuration]);
  const segmentCount = Math.max(0, boundaries.length - 1);
  const validSelectedCount = [...selectedSegments].filter((i) => !excludedSegments.has(i)).length;
  const canExport = ffmpegReady && !isExporting && validSelectedCount > 0;
  const visibleWindowDuration = videoDuration ? videoDuration / zoomLevel : 0;
  const windowEnd = Math.min(videoDuration, zoomStart + visibleWindowDuration);

  const clampZoomStart = useCallback((start: number, level = zoomLevelRef.current, duration = videoDurationRef.current) => {
    if (!duration) return 0;
    const windowDur = duration / level;
    const maxStart = Math.max(0, duration - windowDur);
    return Math.max(0, Math.min(maxStart, start));
  }, []);

  const setZoomStart = useCallback((start: number) => {
    const next = clampZoomStart(start);
    zoomStartRef.current = next;
    setZoomStartState(next);
    return next;
  }, [clampZoomStart]);

  const timeToPercent = useCallback((time: number) => {
    const duration = videoDurationRef.current;
    const level = zoomLevelRef.current;
    if (!duration) return 0;
    return ((time - zoomStartRef.current) / (duration / level)) * 100;
  }, []);

  const percentToTime = useCallback((pct: number) => {
    const duration = videoDurationRef.current;
    if (!duration) return 0;
    const windowDur = duration / zoomLevelRef.current;
    return Math.max(0, Math.min(duration, zoomStartRef.current + pct * windowDur));
  }, []);

  const labels = useMemo(() => {
    if (!videoDuration || !visibleWindowDuration) return [];
    const desiredLabels = Math.max(1, Math.min(12, Math.floor(timelineWidth / 60)));
    const rawStep = visibleWindowDuration / desiredLabels;
    const steps = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 300, 600, 900, 1800, 3600];
    const step = steps.find((s) => s >= rawStep) ?? steps[steps.length - 1];
    const values: Array<{ time: number; pct: number }> = [];
    for (let t = Math.ceil(zoomStart / step) * step; t <= windowEnd + 0.001; t += step) {
      if (t < zoomStart - 0.001 || t > windowEnd + 0.001) continue;
      values.push({ time: t, pct: ((t - zoomStart) / visibleWindowDuration) * 100 });
    }
    return values;
  }, [timelineWidth, videoDuration, visibleWindowDuration, windowEnd, zoomStart]);

  const timelineSegments = useMemo(() => {
    if (!videoDuration) return [];
    return boundaries.slice(0, -1).flatMap((start, i) => {
      const end = boundaries[i + 1];
      if (end <= zoomStart || start >= windowEnd) return [];
      const visibleStart = Math.max(start, zoomStart);
      const visibleEnd = Math.min(end, windowEnd);
      return [{
        index: i,
        left: ((visibleStart - zoomStart) / visibleWindowDuration) * 100,
        width: ((visibleEnd - visibleStart) / visibleWindowDuration) * 100,
      }];
    });
  }, [boundaries, videoDuration, visibleWindowDuration, windowEnd, zoomStart]);

  const updateTimelineWidth = useCallback(() => {
    setTimelineWidth(timelineTrackRef.current?.clientWidth || timelineTrackRef.current?.offsetWidth || 600);
  }, []);

  useEffect(() => {
    updateTimelineWidth();
    window.addEventListener('resize', updateTimelineWidth);
    return () => window.removeEventListener('resize', updateTimelineWidth);
  }, [updateTimelineWidth]);

  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-w', `${sidebarWidth}px`);
  }, [sidebarWidth]);

  useEffect(() => () => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
  }, [videoUrl]);

  useEffect(() => {
    let cancelled = false;
    async function loadFFmpeg() {
      setFfmpegStatus({ text: 'Loading…', cls: 'loading' });
      let lastErr: unknown;
      for (const cdn of FFMPEG_CDN_CANDIDATES) {
        try {
          if (!window.FFmpeg) await loadScript(cdn.script);
          if (!window.FFmpeg) throw new Error('FFmpeg global was not registered');
          const { createFFmpeg, fetchFile } = window.FFmpeg;
          const instance = createFFmpeg({ corePath: cdn.core, log: false });
          await instance.load();
          if (cancelled) return;
          ffmpegRef.current = instance;
          fetchFileRef.current = fetchFile;
          setFfmpegReady(true);
          setFfmpegStatus({ text: 'Ready', cls: 'ready' });
          showToast('FFmpeg loaded — ready to export', 'success');
          return;
        } catch (err) {
          lastErr = err;
          console.warn('FFmpeg CDN failed, trying next…', cdn.script, err);
          ffmpegRef.current = null;
        }
      }
      console.error('FFmpeg load error:', lastErr);
      if (!cancelled) {
        setFfmpegStatus({ text: 'Error', cls: 'error' });
        showToast('FFmpeg failed to load. Export unavailable.', 'error', 5000);
      }
    }
    void loadFFmpeg();
    return () => { cancelled = true; };
  }, [showToast]);

  const loadVideoFile = useCallback((file: File) => {
    if (file.size > FILE_SIZE_MAX) {
      showToast('ファイルが大きすぎます（上限 2GB）。処理できません。', 'error', 6000);
      return;
    }
    if (file.size > FILE_SIZE_WARN) {
      showToast('大きいファイルです。処理中にブラウザが応答しなくなる場合があります。', 'error', 6000);
    }

    const url = URL.createObjectURL(file);
    setVideoUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });
    setVideoFile(file);
    setVideoDuration(0);
    setCurrentTime(0);
    setSplitPoints([]);
    setSelectedSegments(new Set());
    setExcludedSegments(new Set());
    setSegmentNames({});
    setSegmentPlayEnd(null);
    setZoomLevelState(1);
    zoomLevelRef.current = 1;
    setZoomStartState(0);
    zoomStartRef.current = 0;
    ffmpegInputNameRef.current = null;
    setVideoMeta({ resolution: '—', filesize: formatBytes(file.size) });
  }, [showToast]);

  const applyAutosave = useCallback((data: RestorePrompt) => {
    const duration = videoDurationRef.current;
    const nextSplits = (data.splitPoints ?? []).filter((t) => t > 0 && t < duration).sort((a, b) => a - b);
    const maxIdx = nextSplits.length;
    const nextNames = data.segmentNames ?? {};
    const nextExcluded = new Set((data.excludedSegments ?? []).filter((i) => i <= maxIdx));
    const nextSelected = new Set((data.selectedSegments ?? []).filter((i) => i <= maxIdx && !nextExcluded.has(i)));
    splitPointsRef.current = nextSplits;
    segmentNamesRef.current = nextNames;
    excludedSegmentsRef.current = nextExcluded;
    selectedSegmentsRef.current = nextSelected;
    setSplitPoints(nextSplits);
    setSegmentNames(nextNames);
    setExcludedSegments(nextExcluded);
    setSelectedSegments(nextSelected);
    saveAutosave({ splitPoints: nextSplits, segmentNames: nextNames, excludedSegments: nextExcluded, selectedSegments: nextSelected });
    showToast('前回の作業を再開しました', 'success');
  }, [saveAutosave, showToast]);

  const showRestorePrompt = useCallback((data: RestorePrompt) => {
    const id = ++toastIdRef.current;
    const remove = () => setToasts((items) => items.filter((item) => item.id !== id));
    setToasts((items) => [...items, {
      id,
      message: `前回の作業を再開しますか？ (${data.splitPoints.length}分割点)`,
      type: '',
      duration: 15000,
      action: { label: '再開する', onClick: () => { applyAutosave(data); remove(); } },
    }]);
    setTimeout(remove, 15000);
  }, [applyAutosave]);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    const file = videoFileRef.current;
    if (!video || !file) return;
    const duration = video.duration || 0;
    videoDurationRef.current = duration;
    setVideoDuration(duration);
    setVideoMeta({ resolution: `${video.videoWidth} × ${video.videoHeight}`, filesize: formatBytes(file.size) });
    updateTimelineWidth();
    const savedRaw = localStorage.getItem(getFileKey(file));
    if (savedRaw) {
      try {
        const saved = JSON.parse(savedRaw) as RestorePrompt & { version: number };
        if (saved.version === 1 && saved.splitPoints?.length > 0) showRestorePrompt(saved);
      } catch (_) {}
    }
  }, [showRestorePrompt, updateTimelineWidth]);

  const doSeek = useCallback(() => {
    const video = videoRef.current;
    if (!video || pendingScrubTimeRef.current === null) return;
    seekBusyRef.current = true;
    const t = pendingScrubTimeRef.current;
    pendingScrubTimeRef.current = null;
    if (video.fastSeek) video.fastSeek(t);
    else video.currentTime = t;
  }, []);

  const applySeek = useCallback((time: number) => {
    pendingScrubTimeRef.current = time;
    if (!seekBusyRef.current) doSeek();
  }, [doSeek]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  }, []);

  const autoPanTimeline = useCallback((time: number) => {
    const duration = videoDurationRef.current;
    const level = zoomLevelRef.current;
    if (!duration || level === 1 || isScrubbingRef.current) return;
    const windowDur = duration / level;
    const min = zoomStartRef.current + windowDur * 0.25;
    const max = zoomStartRef.current + windowDur * 0.75;
    if (time < min || time > max) setZoomStart(time - windowDur / 2);
  }, [setZoomStart]);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const end = segmentPlayEndRef.current;
    if (end !== null && video.currentTime >= end) {
      segmentPlayEndRef.current = null;
      setSegmentPlayEnd(null);
      video.pause();
      video.currentTime = end;
      setCurrentTime(end);
      return;
    }
    setCurrentTime(video.currentTime);
    autoPanTimeline(video.currentTime);
  }, [autoPanTimeline]);

  const setZoomLevel = useCallback((nextLevel: number, recenter = true) => {
    const duration = videoDurationRef.current;
    if (!ZOOM_LEVELS.includes(nextLevel) || !duration) return;
    const current = videoRef.current?.currentTime ?? 0;
    zoomLevelRef.current = nextLevel;
    setZoomLevelState(nextLevel);
    const windowDur = duration / nextLevel;
    const nextStart = recenter ? current - windowDur / 2 : zoomStartRef.current;
    setZoomStart(nextStart);
  }, [setZoomStart]);

  const stepZoom = useCallback((direction: number) => {
    const idx = ZOOM_LEVELS.indexOf(zoomLevelRef.current);
    const nextIdx = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, idx + direction));
    setZoomLevel(ZOOM_LEVELS[nextIdx]);
  }, [setZoomLevel]);

  const seekToPositionX = useCallback((clientX: number) => {
    const track = timelineTrackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const time = percentToTime(pct);
    setCurrentTime(time);
    applySeek(time);
    return time;
  }, [applySeek, percentToTime]);

  const toggleSegmentAtTime = useCallback((time: number) => {
    const duration = videoDurationRef.current;
    if (!duration) return;
    const points = splitPointsRef.current;
    const nextBoundaries = [0, ...points, duration];
    for (let i = 0; i < nextBoundaries.length - 1; i += 1) {
      if (time >= nextBoundaries[i] && time < nextBoundaries[i + 1] && !excludedSegmentsRef.current.has(i)) {
        const next = new Set(selectedSegmentsRef.current);
        if (next.has(i)) next.delete(i);
        else next.add(i);
        selectedSegmentsRef.current = next;
        setSelectedSegments(next);
        saveAutosave({ selectedSegments: next });
        break;
      }
    }
  }, [saveAutosave]);

  const addSplitAtCurrentTime = useCallback(() => {
    const video = videoRef.current;
    const duration = videoDurationRef.current;
    if (!video) return;
    const time = video.currentTime;
    if (!duration || time <= 0 || time >= duration) {
      showToast('Cannot add split at start or end', 'error');
      return;
    }
    if (splitPointsRef.current.some((point) => Math.abs(point - time) < 0.1)) {
      showToast('Split point already exists here', 'error');
      return;
    }
    const next = [...splitPointsRef.current, time].sort((a, b) => a - b);
    splitPointsRef.current = next;
    setSplitPoints(next);
    saveAutosave({ splitPoints: next });
    showToast(`Split added at ${formatTime(time)}`, 'success');
  }, [saveAutosave, showToast]);

  const deleteMarker = useCallback((index: number) => {
    const points = splitPointsRef.current;
    const removed = points[index];
    const next = points.filter((_, i) => i !== index);
    splitPointsRef.current = next;
    setSplitPoints(next);
    saveAutosave({ splitPoints: next });
    showToast(`Split at ${formatTime(removed)} removed`);
  }, [saveAutosave, showToast]);

  const toggleExcludeSegment = useCallback((index: number) => {
    const nextExcluded = new Set(excludedSegmentsRef.current);
    const nextSelected = new Set(selectedSegmentsRef.current);
    if (nextExcluded.has(index)) nextExcluded.delete(index);
    else {
      nextExcluded.add(index);
      nextSelected.delete(index);
    }
    excludedSegmentsRef.current = nextExcluded;
    selectedSegmentsRef.current = nextSelected;
    setExcludedSegments(nextExcluded);
    setSelectedSegments(nextSelected);
    saveAutosave({ excludedSegments: nextExcluded, selectedSegments: nextSelected });
  }, [saveAutosave]);

  const playSegment = useCallback((index: number, start: number, end: number) => {
    const video = videoRef.current;
    if (!video) return;
    const isActive = segmentPlayEndRef.current === end;
    if (isActive && !video.paused) {
      video.pause();
      return;
    }
    if (isActive && video.paused) {
      void video.play();
      return;
    }
    segmentPlayEndRef.current = end;
    setSegmentPlayEnd(end);
    video.currentTime = start;
    setCurrentTime(start);
    void video.play();
  }, []);

  const toggleSelectAll = useCallback(() => {
    const count = Math.max(0, [0, ...splitPointsRef.current, videoDurationRef.current].length - 1);
    const selectable = Array.from({ length: count }, (_, i) => i).filter((i) => !excludedSegmentsRef.current.has(i));
    const allSelected = selectable.length > 0 && selectable.every((i) => selectedSegmentsRef.current.has(i));
    const next = allSelected ? new Set<number>() : new Set(selectable);
    selectedSegmentsRef.current = next;
    setSelectedSegments(next);
    saveAutosave({ selectedSegments: next });
  }, [saveAutosave]);

  const updateSegmentName = useCallback((index: number, value: string, persist = false) => {
    const next = { ...segmentNamesRef.current, [index]: value };
    segmentNamesRef.current = next;
    setSegmentNames(next);
    if (persist) saveAutosave({ segmentNames: next });
  }, [saveAutosave]);

  const commitSegmentName = useCallback((index: number, value: string) => {
    updateSegmentName(index, value.trim() || `Segment ${index + 1}`, true);
  }, [updateSegmentName]);

  const saveProject = useCallback(() => {
    const file = videoFileRef.current;
    if (!file) return;
    const project: ProjectFile = {
      version: 1,
      videoFileName: file.name,
      splitPoints: splitPointsRef.current,
      segmentNames: segmentNamesRef.current,
      excludedSegments: [...excludedSegmentsRef.current],
      selectedSegments: [...selectedSegmentsRef.current],
    };
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${file.name}.moviecut.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  const loadProject = useCallback((file: File) => {
    if (!videoFileRef.current) {
      showToast('先に動画ファイルを読み込んでください', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result)) as ProjectFile;
        if (data.version !== 1) {
          showToast('対応していないプロジェクトファイルです', 'error');
          return;
        }
        const duration = videoDurationRef.current;
        const nextSplits = (data.splitPoints ?? []).filter((t) => t > 0 && t < duration).sort((a, b) => a - b);
        const nextExcluded = new Set(data.excludedSegments ?? []);
        const nextSelected = new Set((data.selectedSegments ?? []).filter((i) => !nextExcluded.has(i)));
        splitPointsRef.current = nextSplits;
        segmentNamesRef.current = data.segmentNames ?? {};
        excludedSegmentsRef.current = nextExcluded;
        selectedSegmentsRef.current = nextSelected;
        setSplitPoints(nextSplits);
        setSegmentNames(data.segmentNames ?? {});
        setExcludedSegments(nextExcluded);
        setSelectedSegments(nextSelected);
        saveAutosave({ splitPoints: nextSplits, segmentNames: data.segmentNames ?? {}, excludedSegments: nextExcluded, selectedSegments: nextSelected });
        showToast('プロジェクトを読み込みました');
      } catch (_) {
        showToast('プロジェクトの読み込みに失敗しました', 'error');
      } finally {
        if (projectInputRef.current) projectInputRef.current.value = '';
      }
    };
    reader.onerror = () => {
      showToast('プロジェクトの読み込みに失敗しました', 'error');
      if (projectInputRef.current) projectInputRef.current.value = '';
    };
    reader.readAsText(file);
  }, [saveAutosave, showToast]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
      if (!videoFileRef.current) return;
      const video = videoRef.current;
      switch (event.code) {
        case 'Space':
          event.preventDefault();
          togglePlay();
          break;
        case 'KeyS':
        case 'KeyM':
          event.preventDefault();
          addSplitAtCurrentTime();
          break;
        case 'ArrowLeft':
          if (!video) return;
          event.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - (event.shiftKey ? 0.1 : 10));
          break;
        case 'ArrowRight':
          if (!video) return;
          event.preventDefault();
          video.currentTime = Math.min(videoDurationRef.current, video.currentTime + (event.shiftKey ? 0.1 : 10));
          break;
        case 'KeyZ': {
          event.preventDefault();
          const points = splitPointsRef.current;
          if (points.length > 0) {
            const removed = points[points.length - 1];
            const next = points.slice(0, -1);
            splitPointsRef.current = next;
            setSplitPoints(next);
            saveAutosave({ splitPoints: next });
            showToast(`Split at ${formatTime(removed)} undone`);
          }
          break;
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [addSplitAtCurrentTime, saveAutosave, showToast, togglePlay]);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => handleMarkerDrag(event.clientX);
    const onMouseUp = () => endMarkerDrag();
    const onTouchMove = (event: TouchEvent) => {
      if (!draggingMarkerRef.current || !event.touches[0]) return;
      event.preventDefault();
      handleMarkerDrag(event.touches[0].clientX);
    };
    const onTouchEnd = () => endMarkerDrag();

    function handleMarkerDrag(clientX: number) {
      const dragging = draggingMarkerRef.current;
      const track = timelineTrackRef.current;
      if (!dragging || !track) return;
      const rect = track.getBoundingClientRect();
      const dx = clientX - dragging.startX;
      const dt = (dx / rect.width) * (videoDurationRef.current / zoomLevelRef.current);
      let newTime = Math.max(0.05, Math.min(videoDurationRef.current - 0.05, dragging.startTime + dt));
      const otherTimes = splitPointsRef.current.filter((_, idx) => idx !== dragging.index);
      if (otherTimes.some((time) => Math.abs(newTime - time) < 0.1)) return;
      newTime = Number(newTime.toFixed(3));
      const next = [...splitPointsRef.current];
      next[dragging.index] = newTime;
      next.sort((a, b) => a - b);
      draggingMarkerRef.current = { ...dragging, index: next.indexOf(newTime) };
      splitPointsRef.current = next;
      setSplitPoints(next);
    }

    function endMarkerDrag() {
      if (!draggingMarkerRef.current) return;
      draggingMarkerRef.current = null;
      saveAutosave({ splitPoints: splitPointsRef.current });
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [saveAutosave]);

  const startTimelinePointer = useCallback((clientX: number, isTouch = false) => {
    const track = timelineTrackRef.current;
    if (!track) return { initTime: 0, startX: clientX };
    setIsScrubbing(true);
    const rect = track.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const initTime = percentToTime(pct);
    setCurrentTime(initTime);
    return { initTime, startX: clientX, isTouch };
  }, [percentToTime]);

  const handleTimelineMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.classList.contains('split-marker') || target.classList.contains('marker-handle') || target.classList.contains('marker-delete')) return;
    event.preventDefault();
    const { initTime, startX } = startTimelinePointer(event.clientX);
    let isDragging = false;
    const onMove = (moveEvent: MouseEvent) => {
      if (!isDragging && Math.abs(moveEvent.clientX - startX) > 4) {
        isDragging = true;
        wasPlayingBeforeScrubRef.current = !videoRef.current?.paused;
        if (wasPlayingBeforeScrubRef.current) videoRef.current?.pause();
        applySeek(initTime);
      }
      if (isDragging) seekToPositionX(moveEvent.clientX);
    };
    const onUp = () => {
      setIsScrubbing(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (isDragging) {
        if (wasPlayingBeforeScrubRef.current) void videoRef.current?.play();
      } else {
        applySeek(initTime);
        toggleSegmentAtTime(initTime);
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [applySeek, seekToPositionX, startTimelinePointer, toggleSegmentAtTime]);

  const beginPinchZoom = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if (!videoDurationRef.current || event.touches.length < 2) return;
    event.preventDefault();
    const distance = (touches: TouchList | React.TouchList) => {
      const first = touches.item(0);
      const second = touches.item(1);
      if (!first || !second) return 0;
      return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
    };
    const startDistance = distance(event.touches);
    const startZoomIndex = ZOOM_LEVELS.indexOf(zoomLevelRef.current);
    const onMove = (moveEvent: TouchEvent) => {
      if (moveEvent.touches.length < 2) return;
      moveEvent.preventDefault();
      const ratio = distance(moveEvent.touches) / startDistance;
      const delta = Math.round(Math.log(ratio) / Math.log(1.35));
      const nextIdx = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, startZoomIndex + delta));
      if (ZOOM_LEVELS[nextIdx] !== zoomLevelRef.current) setZoomLevel(ZOOM_LEVELS[nextIdx]);
    };
    const onEnd = () => {
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', onEnd);
  }, [setZoomLevel]);

  const handleTimelineTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if (event.touches.length === 2) {
      beginPinchZoom(event);
      return;
    }
    const target = event.target as HTMLElement;
    if (target.classList.contains('split-marker') || target.classList.contains('marker-handle') || target.classList.contains('marker-delete')) return;
    event.preventDefault();
    const firstTouch = event.touches[0];
    const { initTime, startX } = startTimelinePointer(firstTouch.clientX, true);
    let isDragging = false;
    const onMove = (moveEvent: TouchEvent) => {
      if (moveEvent.touches.length !== 1) return;
      moveEvent.preventDefault();
      const clientX = moveEvent.touches[0].clientX;
      if (!isDragging && Math.abs(clientX - startX) > 6) {
        isDragging = true;
        wasPlayingBeforeScrubRef.current = !videoRef.current?.paused;
        if (wasPlayingBeforeScrubRef.current) videoRef.current?.pause();
        applySeek(initTime);
      }
      if (isDragging) seekToPositionX(clientX);
    };
    const onEnd = () => {
      setIsScrubbing(false);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      if (isDragging) {
        if (wasPlayingBeforeScrubRef.current) void videoRef.current?.play();
      } else {
        applySeek(initTime);
        toggleSegmentAtTime(initTime);
      }
    };
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
  }, [applySeek, beginPinchZoom, seekToPositionX, startTimelinePointer, toggleSegmentAtTime]);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (!videoDurationRef.current) return;
    event.preventDefault();
    stepZoom(event.deltaY < 0 ? 1 : -1);
  }, [stepZoom]);

  const handleSidebarMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let frame = 0;
    let pending = startWidth;
    const onMove = (moveEvent: MouseEvent) => {
      pending = Math.max(200, Math.min(500, startWidth - (moveEvent.clientX - startX)));
      if (!frame) {
        frame = requestAnimationFrame(() => {
          setSidebarWidth(pending);
          frame = 0;
        });
      }
    };
    const onUp = () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      updateTimelineWidth();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [sidebarWidth, updateTimelineWidth]);

  const getOutputFilename = useCallback((index: number) => {
    const customName = (segmentNamesRef.current[index] ?? `Segment ${index + 1}`).trim();
    const safeName = customName.replace(/[/\\:*?"<>|]/g, '_');
    return `${safeName}.mp4`;
  }, []);

  const isMobile = () => navigator.maxTouchPoints > 0;

  const saveFile = useCallback(async (blob: Blob, filename: string, segNum: number, silent = false) => {
    if (!isMobile() && window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          startIn: savePickerStartInRef.current,
          types: [{ description: 'MP4 Video', accept: { 'video/mp4': ['.mp4'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        savePickerStartInRef.current = handle;
        if (!silent) showToast(`Segment ${segNum} saved`, 'success');
        return true;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return false;
      }
    }

    const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean; share?: (data: ShareData) => Promise<void> };
    if (isMobile() && nav.canShare && nav.share) {
      const file = new File([blob], filename, { type: 'video/mp4' });
      if (nav.canShare({ files: [file] })) {
        showToast(`Segment ${segNum} ready — `, '', 30000, {
          label: '↓ 保存する',
          onClick: () => nav.share?.({ files: [file] }).catch((err) => {
            if (!(err instanceof DOMException && err.name === 'AbortError')) showToast('保存に失敗しました', 'error');
          }),
        });
        return true;
      }
    }

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (!silent) showToast(`Segment ${segNum} downloaded`, 'success');
    return true;
  }, [showToast]);

  const exportSegment = useCallback(async (index: number, start: number, end: number, silent = false) => {
    const ffmpeg = ffmpegRef.current;
    const fetchFile = fetchFileRef.current;
    const file = videoFileRef.current;
    if (!ffmpegReady || !ffmpeg || !fetchFile || !file) return silent ? false : undefined;
    if (isExporting && !silent) {
      showToast('Export already in progress', 'error');
      return undefined;
    }

    const inputName = `input_${file.name.replace(/[^a-zA-Z0-9.]/g, '_')}`;
    const outputName = `out_seg_${index}.mp4`;
    const duration = end - start;
    setSegmentProgress((items) => ({ ...items, [index]: 5 }));

    try {
      if (ffmpegInputNameRef.current !== inputName) {
        if (ffmpegInputNameRef.current) {
          try { ffmpeg.FS('unlink', ffmpegInputNameRef.current); } catch (_) {}
        }
        ffmpeg.FS('writeFile', inputName, await fetchFile(file));
        ffmpegInputNameRef.current = inputName;
      }

      setSegmentProgress((items) => ({ ...items, [index]: 30 }));
      ffmpeg.setLogger(({ message }) => {
        if (!message.includes('time=')) return;
        const match = message.match(/time=(\d+):(\d+):([\d.]+)/);
        if (!match) return;
        const elapsed = Number.parseInt(match[1], 10) * 3600 + Number.parseInt(match[2], 10) * 60 + Number.parseFloat(match[3]);
        const pct = Math.min(95, 30 + (elapsed / duration) * 65);
        setSegmentProgress((items) => ({ ...items, [index]: pct }));
      });

      await ffmpeg.run(
        '-ss', String(Math.max(0, start - 5)),
        '-i', inputName,
        '-ss', String(start < 5 ? start : 5),
        '-t', String(duration),
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '18',
        '-c:a', 'aac',
        '-b:a', '192k',
        outputName,
      );

      ffmpeg.setLogger(() => {});
      setSegmentProgress((items) => ({ ...items, [index]: 100 }));
      const data = ffmpeg.FS('readFile', outputName);
      ffmpeg.FS('unlink', outputName);
      const outputBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      const blob = new Blob([outputBuffer], { type: 'video/mp4' });
      const saved = await saveFile(blob, getOutputFilename(index), index + 1, silent);
      return silent ? saved : undefined;
    } catch (err) {
      console.error('Export error:', err);
      if (!silent) showToast(`Export failed: ${err instanceof Error ? err.message : String(err)}`, 'error', 5000);
      setSegmentProgress((items) => ({ ...items, [index]: 0 }));
      return silent ? false : undefined;
    } finally {
      setTimeout(() => {
        setSegmentProgress((items) => {
          const next = { ...items };
          delete next[index];
          return next;
        });
      }, 1200);
    }
  }, [ffmpegReady, getOutputFilename, isExporting, saveFile, showToast]);

  const exportSelectedSegments = useCallback(async () => {
    if (!ffmpegReady || !videoFileRef.current || isExporting || selectedSegmentsRef.current.size === 0) return;
    setIsExporting(true);
    const points = splitPointsRef.current;
    const duration = videoDurationRef.current;
    const nextBoundaries = [0, ...points, duration];
    const indices = [...selectedSegmentsRef.current].filter((i) => !excludedSegmentsRef.current.has(i)).sort((a, b) => a - b);
    const total = indices.length;
    setGlobalProgress({ active: true, label: `保存中… 0 / ${total}`, pct: 0 });
    const failedSegments: string[] = [];

    for (let n = 0; n < total; n += 1) {
      const index = indices[n];
      setGlobalProgress({ active: true, label: `保存中… ${n + 1} / ${total}`, pct: (n / total) * 100 });
      const succeeded = await exportSegment(index, nextBoundaries[index], nextBoundaries[index + 1], true);
      if (!succeeded) failedSegments.push((segmentNamesRef.current[index] ?? `Segment ${index + 1}`).trim() || `Segment ${index + 1}`);
    }

    if (failedSegments.length === 0) {
      setGlobalProgress({ active: true, label: `完了 — ${total}件保存しました`, pct: 100 });
      setTimeout(() => setGlobalProgress((progress) => ({ ...progress, active: false, pct: 0 })), 3000);
      showToast(`${total}件のセグメントを保存しました`, 'success');
    } else {
      setGlobalProgress({ active: true, label: `一部失敗 — ${total - failedSegments.length} / ${total}件保存しました`, pct: ((total - failedSegments.length) / total) * 100 });
      showToast(`${failedSegments.join(', ')} failed to export`, 'error', 7000);
    }
    setIsExporting(false);
  }, [exportSegment, ffmpegReady, isExporting, showToast]);

  const allSelectableSelected = segmentCount > 0 && Array.from({ length: segmentCount }, (_, i) => i)
    .filter((i) => !excludedSegments.has(i))
    .every((i) => selectedSegments.has(i));

  return (
    <>
      {!videoFile && (
        <div
          id="drop-zone"
          className={dragOver ? 'drag-over' : ''}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            const file = event.dataTransfer.files[0];
            if (file && isVideoFile(file)) loadVideoFile(file);
            else showToast('Please drop a video file', 'error');
          }}
        >
          <div className="drop-icon">🎬</div>
          <h2>Drop a video file here</h2>
          <p>or click to browse — supports MP4, MKV, MOV, WebM, AVI…</p>
          <button className="btn btn-primary" id="browse-btn" onClick={(event) => { event.stopPropagation(); fileInputRef.current?.click(); }}>Browse file</button>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        id="file-input"
        accept="video/*"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) loadVideoFile(file);
          event.currentTarget.value = '';
        }}
      />

      {videoFile && (
        <div id="app">
          <header id="header">
            <div className="logo">Movie<span>Cut</span></div>
            <span id="file-name-label" style={{ color: 'var(--text-dim)', fontSize: 12 }}>{videoFile.name}</span>
            <div id="header-actions">
              <button className="btn btn-secondary" id="change-file-btn" onClick={() => fileInputRef.current?.click()}>Change file</button>
              <button className="btn btn-primary" id="add-split-header-btn" onClick={addSplitAtCurrentTime}>✂ Add split here</button>
            </div>
          </header>

          <div id="player-area">
            {!videoUrl && <div id="player-placeholder">No video loaded</div>}
            <video
              ref={videoRef}
              id="video"
              preload="metadata"
              src={videoUrl}
              onLoadedMetadata={handleLoadedMetadata}
              onTimeUpdate={handleTimeUpdate}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={() => setIsPlaying(false)}
              onSeeked={() => {
                seekBusyRef.current = false;
                if (pendingScrubTimeRef.current !== null) doSeek();
              }}
            />
            <div id="controls">
              <button id="play-btn" title="Play/Pause (Space)" onClick={togglePlay}>{isPlaying ? '⏸' : '▶'}</button>
              <span className="time-display" id="time-display">{formatTime(currentTime)} / {formatTime(videoDuration)}</span>
              <input
                type="range"
                id="volume-slider"
                min="0"
                max="1"
                step="0.05"
                value={volume}
                title="Volume"
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setVolume(next);
                  if (videoRef.current) videoRef.current.volume = next;
                }}
              />
              <button className="btn btn-secondary btn-icon add-split-btn-ctrl" id="add-split-btn-ctrl" title="Add split at current time (S / M)" onClick={addSplitAtCurrentTime}>✂ Split</button>
            </div>
          </div>

          <div id="timeline-area">
            <div id="timeline-labels">
              {labels.map((label) => <div key={label.time} className="tl-label" style={{ left: `${label.pct}%` }}>{formatTime(label.time)}</div>)}
            </div>
            <div id="timeline-track-wrap">
              <div
                ref={timelineTrackRef}
                id="timeline-track"
                onMouseDown={handleTimelineMouseDown}
                onTouchStart={handleTimelineTouchStart}
                onWheel={handleWheel}
              >
                {timelineSegments.map((seg) => (
                  <div
                    key={seg.index}
                    className={`tl-segment${selectedSegments.has(seg.index) && !excludedSegments.has(seg.index) ? ' seg-selected' : ''}`}
                    data-index={seg.index}
                    style={{
                      left: `${seg.left}%`,
                      width: `${seg.width}%`,
                      background: excludedSegments.has(seg.index)
                        ? 'repeating-linear-gradient(45deg, #1a1d27 0px, #1a1d27 4px, #2e3350 4px, #2e3350 8px)'
                        : COLORS[seg.index % COLORS.length],
                      opacity: excludedSegments.has(seg.index) ? 0.6 : undefined,
                    }}
                  />
                ))}
                {splitPoints.map((time, index) => {
                  const pct = timeToPercent(time);
                  if (pct < 0 || pct > 100) return null;
                  return (
                    <div
                      key={`${time}-${index}`}
                      className="split-marker"
                      data-index={index}
                      title={formatTime(time)}
                      style={{ left: `${pct}%` }}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        draggingMarkerRef.current = { index, startX: event.clientX, startTime: splitPointsRef.current[index] };
                      }}
                      onTouchStart={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        draggingMarkerRef.current = { index, startX: event.touches[0].clientX, startTime: splitPointsRef.current[index] };
                      }}
                      onContextMenu={(event) => { event.preventDefault(); deleteMarker(index); }}
                    >
                      <div className="marker-handle" />
                      <button className="marker-delete" title="Delete split" onClick={(event) => { event.stopPropagation(); deleteMarker(index); }}>✕</button>
                    </div>
                  );
                })}
                <div id="playhead" style={{ left: `${videoDuration ? timeToPercent(currentTime) : 0}%` }} />
              </div>
            </div>
            <div id="timeline-actions">
              <div id="timeline-zoom-controls" aria-label="Timeline zoom">
                <button className="timeline-zoom-btn" id="timeline-zoom-out" title="Zoom out" disabled={ZOOM_LEVELS.indexOf(zoomLevel) <= 0 || !videoDuration} onClick={() => stepZoom(-1)}>−</button>
                <button className="timeline-zoom-btn" id="timeline-zoom-reset" title="Reset zoom" disabled={!videoDuration} onClick={() => setZoomLevel(1)}>{zoomLevel}×</button>
                <button className="timeline-zoom-btn" id="timeline-zoom-in" title="Zoom in" disabled={ZOOM_LEVELS.indexOf(zoomLevel) >= ZOOM_LEVELS.length - 1 || !videoDuration} onClick={() => stepZoom(1)}>+</button>
              </div>
              <span id="split-hint">
                <kbd style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 5px', fontSize: 10, fontFamily: 'monospace' }}>S</kbd>
                {' '}or{' '}
                <kbd style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 5px', fontSize: 10, fontFamily: 'monospace' }}>M</kbd>
                &nbsp;— add split point &nbsp;|&nbsp; drag markers to adjust &nbsp;|&nbsp; hover marker → ✕ to delete
              </span>
            </div>
          </div>

          <div id="segments-area">
            <div id="segments-header">
              <h3>Segments</h3>
              <span id="segments-count">{segmentCount}</span>
              <span id="selected-count" className={validSelectedCount ? 'visible' : ''}>{validSelectedCount ? `${validSelectedCount}件選択中` : ''}</span>
              <button className="btn btn-secondary" id="select-all-btn" disabled={segmentCount === 0} onClick={toggleSelectAll}>{allSelectableSelected ? '全解除' : '全選択'}</button>
            </div>
            <div id="segments-list">
              {boundaries.slice(0, -1).map((start, index) => {
                const end = boundaries[index + 1];
                const isExcluded = excludedSegments.has(index);
                const progress = segmentProgress[index] ?? 0;
                const isActiveSegment = segmentPlayEnd === end;
                const isSegmentPlaying = isActiveSegment && isPlaying;
                const isSegmentPaused = isActiveSegment && !isPlaying;
                return (
                  <div
                    key={index}
                    id={`seg-card-${index}`}
                    className={`segment-card${selectedSegments.has(index) ? ' selected' : ''}${isExcluded ? ' excluded' : ''}`}
                    onClick={() => {
                      if (isExcluded) return;
                      const next = new Set(selectedSegmentsRef.current);
                      if (next.has(index)) next.delete(index);
                      else next.add(index);
                      selectedSegmentsRef.current = next;
                      setSelectedSegments(next);
                      saveAutosave({ selectedSegments: next });
                    }}
                  >
                    <div className="segment-checkbox">{selectedSegments.has(index) ? '✓' : ''}</div>
                    <div className="segment-color" style={{ background: COLORS[index % COLORS.length] }} />
                    <div className="segment-info">
                      <div className="segment-name-wrap">
                        <input
                          type="text"
                          className="segment-name-input"
                          value={segmentNames[index] ?? `Segment ${index + 1}`}
                          placeholder={`Segment ${index + 1}`}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => updateSegmentName(index, event.target.value)}
                          onCompositionEnd={(event) => updateSegmentName(index, event.currentTarget.value)}
                          onBlur={(event) => commitSegmentName(index, event.target.value)}
                          onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key !== 'Enter') return;
                            const nativeEvent = event.nativeEvent as KeyboardEvent & { isComposing?: boolean };
                            if (nativeEvent.isComposing || nativeEvent.keyCode === 229) return;
                            event.currentTarget.blur();
                          }}
                        />
                      </div>
                      <div className="segment-times">{formatTime(start)} → {formatTime(end)}</div>
                      <div className={`segment-progress${progress > 0 ? ' active' : ''}`} id={`seg-prog-${index}`}>
                        <div className="segment-progress-bar" id={`seg-prog-bar-${index}`} style={{ width: `${progress}%` }} />
                      </div>
                    </div>
                    <div className="segment-duration">{formatTime(end - start)}</div>
                    <button
                      className={`segment-play-btn${isSegmentPlaying ? ' playing' : ''}${isSegmentPaused ? ' paused' : ''}`}
                      title="この区間を再生 / 一時停止"
                      onClick={(event) => { event.stopPropagation(); playSegment(index, start, end); }}
                    >
                      {isSegmentPlaying ? '⏸' : '▶'}
                    </button>
                    <button
                      className="segment-delete-btn"
                      title={isExcluded ? 'セグメントを復元' : 'セグメントをカット（除外）'}
                      onClick={(event) => { event.stopPropagation(); toggleExcludeSegment(index); }}
                    >
                      {isExcluded ? '↺' : '✕'}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <aside id="sidebar">
            <div id="sidebar-resize-handle" onMouseDown={handleSidebarMouseDown} />
            <div id="sidebar-header">
              FFmpeg
              <span id="ffmpeg-status" className={`status-${ffmpegStatus.cls}`}>{ffmpegStatus.text}</span>
            </div>
            <div id="sidebar-content">
              <div className="info-row"><span className="label">Duration</span><span className="value" id="info-duration">{videoDuration ? formatTime(videoDuration) : '—'}</span></div>
              <div className="info-row"><span className="label">Resolution</span><span className="value" id="info-resolution">{videoMeta.resolution}</span></div>
              <div className="info-row"><span className="label">File size</span><span className="value" id="info-filesize">{videoMeta.filesize}</span></div>
              <div className="info-row"><span className="label">Split points</span><span className="value" id="info-splits">{splitPoints.length}</span></div>

              <div className="divider" />

              <div id="global-progress-wrap" className={globalProgress.active ? 'active' : ''}>
                <div id="global-progress-label">{globalProgress.label}</div>
                <div id="global-progress-bar-wrap"><div id="global-progress-bar" style={{ width: `${globalProgress.pct}%` }} /></div>
              </div>

              <button className="btn btn-primary" id="export-all-btn" disabled={!canExport} onClick={exportSelectedSegments}>
                {validSelectedCount ? `⬇ 選択した${validSelectedCount}件を保存` : '⬇ 選択したセグメントを保存'}
              </button>

              <div className="divider" />

              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn" id="save-project-btn" style={{ flex: 1, fontSize: 12 }} disabled={!videoFile} onClick={saveProject}>💾 保存</button>
                <button className="btn" id="load-project-btn" style={{ flex: 1, fontSize: 12 }} onClick={() => projectInputRef.current?.click()}>📂 読み込み</button>
              </div>
              <input
                ref={projectInputRef}
                type="file"
                id="project-file-input"
                accept=".json"
                style={{ display: 'none' }}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) loadProject(file);
                }}
              />

              <div className="divider" />

              <div id="keyboard-shortcuts">
                <strong style={{ color: 'var(--text)', display: 'block', marginBottom: 6 }}>Keyboard shortcuts</strong>
                <kbd>Space</kbd> Play / Pause<br />
                <kbd>S</kbd> / <kbd>M</kbd> Add split point<br />
                <kbd>←</kbd> / <kbd>→</kbd> Seek ±10 s<br />
                <kbd>⇧←</kbd> / <kbd>⇧→</kbd> Seek ±0.1 s<br />
                <kbd>Z</kbd> Undo last split<br />
              </div>

              <div className="divider" />

              <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6 }}>
                Video is split using <strong style={{ color: 'var(--text)' }}>stream copy</strong> (no re-encoding) — fast and lossless.
                Output files are downloaded as individual MP4 files.
              </div>
            </div>
          </aside>
        </div>
      )}

      <div id="toast-container">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast show${toast.type ? ` ${toast.type}` : ''}`} style={toast.action ? { maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 10, pointerEvents: 'auto' } : undefined}>
            <span>{toast.message}</span>
            {toast.action && (
              <button className="toast-save-btn" onClick={toast.action.onClick}>{toast.action.label}</button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

export default App;
