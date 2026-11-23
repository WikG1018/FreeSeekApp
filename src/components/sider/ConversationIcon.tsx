import type { ChatMode } from '../../services/chat/types.js'

export const ConversationIcon = ({ mode }: { mode: ChatMode }) => (
  <svg
    width="17"
    height="17"
    viewBox="0 0 18 18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.35"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {mode === 'agent' ? (
      <>
        <rect x="3.2" y="5.3" width="11.6" height="9" rx="3" />
        <path d="M9 5.3V3.1m-1.2 0h2.4M1.8 9.1v1.5m14.4-1.5v1.5" />
        <path d="M6.8 9.7h.1m4.2 0h.1" strokeWidth="1.8" />
      </>
    ) : (
      <path d="M3.4 13.9l.4-2a5.4 5.4 0 0 1-1.2-3.4c0-3.2 2.8-5.6 6.4-5.6s6.4 2.4 6.4 5.6-2.8 5.7-6.4 5.7c-.9 0-1.7-.2-2.5-.4l-2.2 1.1c-.5.2-1-.2-.9-1zm2.7-6.7h5.8m-5.8 2.7h3.6" />
    )}
  </svg>
)
