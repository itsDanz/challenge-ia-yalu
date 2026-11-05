import { useEffect, useState } from 'react';

export interface ToastMessage {
  text: string;
  id: number;
}

/** Short-lived notice at the bottom of the screen (illegal move, etc.). */
export function Toast({ message }: { message: ToastMessage | null }) {
  const [visible, setVisible] = useState<ToastMessage | null>(null);

  useEffect(() => {
    if (!message) return;
    setVisible(message);
    const t = setTimeout(() => setVisible(null), 2200);
    return () => clearTimeout(t);
  }, [message]);

  return (
    <div className="toast-region" aria-live="assertive" aria-atomic="true">
      {visible && (
        <div className="toast" key={visible.id} data-testid="toast">
          {visible.text}
        </div>
      )}
    </div>
  );
}
