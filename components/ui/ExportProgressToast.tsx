import React, { useEffect, useState } from 'react';
import { CheckCircle2, FileText, Loader2, X, XCircle } from 'lucide-react';
import apiClient from '../../utils/apiClient';
import '../../styles/compliance.css';

interface ExportProgressToastProps {
    jobId: string;
    onClose: () => void;
}

export interface ExportArtifact {
    fileName: string;
    bytes: number | null;
    completedAt: string | null;
    retained: boolean;
    downloadUrl: string;
}

export function formatBytes(bytes: number | null | undefined): string {
    if (!bytes || bytes <= 0) return 'retained artifact';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function exportCompletedMessage(artifact: ExportArtifact | null): string {
    if (!artifact) return 'PDF export completed. Artifact metadata is unavailable.';
    return `PDF export completed: ${artifact.fileName} (${formatBytes(artifact.bytes)}).`;
}

export const ExportProgressToast: React.FC<ExportProgressToastProps> = ({ jobId, onClose }) => {
    const [state, setState] = useState<'waiting' | 'active' | 'completed' | 'failed' | 'unknown'>('waiting');
    const [message, setMessage] = useState<string | null>(null);
    const [artifact, setArtifact] = useState<ExportArtifact | null>(null);
    const [isDownloading, setIsDownloading] = useState(false);

    useEffect(() => {
        const checkStatus = async () => {
            try {
                const response = await apiClient.get(`/api/export/status/${jobId}`);
                if (response.data.success) {
                    setState(response.data.state);
                    if (response.data.state === 'failed') {
                        setMessage(response.data.failedReason ?? 'PDF export failed.');
                    } else if (response.data.state === 'completed') {
                        const nextArtifact = response.data.artifact ?? response.data.result ?? null;
                        setArtifact(nextArtifact);
                        setMessage(exportCompletedMessage(nextArtifact));
                    }
                }
            } catch {
                setState('failed');
                setMessage('PDF export status is unavailable.');
            }
        };

        void checkStatus();
        const intervalId = window.setInterval(() => void checkStatus(), 2000);
        return () => window.clearInterval(intervalId);
    }, [jobId]);

    const downloadArtifact = async () => {
        if (!artifact?.downloadUrl) return;
        setIsDownloading(true);
        try {
            const response = await apiClient.get(artifact.downloadUrl, { responseType: 'blob' });
            const blobUrl = window.URL.createObjectURL(response.data);
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = artifact.fileName;
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.URL.revokeObjectURL(blobUrl);
        } catch {
            setMessage('PDF export was retained, but the download request failed.');
        } finally {
            setIsDownloading(false);
        }
    };

    const status = state === 'completed'
        ? { icon: <CheckCircle2 size={18} className="ex-icon ex-icon--completed" aria-hidden="true" />, text: 'Export Complete' }
        : state === 'failed'
            ? { icon: <XCircle size={18} className="ex-icon ex-icon--failed" aria-hidden="true" />, text: 'Generation Failed' }
            : { icon: <Loader2 size={18} className="ex-icon ex-icon--active" aria-hidden="true" />, text: 'Compiling Report...' };

    return (
        <div className="ex-toast" role="status" aria-live="polite">
            {status.icon}
            <div className="ex-main">
                <p className="ex-title">{status.text}</p>
                <p className="ex-progress">Job {jobId} · {state}</p>
                {message && (
                    <span className="ex-message">
                        <FileText size={12} aria-hidden="true" /> {message}
                    </span>
                )}
                {state === 'completed' && artifact?.downloadUrl && (
                    <button
                        type="button"
                        onClick={() => void downloadArtifact()}
                        disabled={isDownloading}
                        className="ex-btn"
                    >
                        <FileText size={12} aria-hidden="true" /> {isDownloading ? 'Downloading...' : 'Download PDF'}
                    </button>
                )}
            </div>
            <button type="button" onClick={onClose} className="ex-close" aria-label="Close">
                <X size={16} aria-hidden="true" />
            </button>
        </div>
    );
};
