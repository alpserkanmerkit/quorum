/* eslint-disable @typescript-eslint/no-explicit-any */
import { apiFetch } from '../utils/apiClient';

export const createAdvisorySession = (): any => {
  return { isProxy: true };
};

export const sendAdvisoryMessage = async (
  chat: any,
  message: string,
): Promise<string> => {
  try {
    const res = await apiFetch('/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: message }] })
    });
    if (!res.ok) throw new Error('Backend error');
    const data = await res.json();
    return data.text || data.reply || "No response received from Quorum Brain.";
  } catch (error) {
    console.error("Advisory Chat Error:", error);
    return "Error connecting to Quorum Orchestrator. Please try again.";
  }
};
