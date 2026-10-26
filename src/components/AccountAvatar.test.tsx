import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AccountAvatar } from './AccountAvatar';

const identity = { avatarUrl: 'data:image/png;base64,AA==', label: 'Listener', initial: 'L' };

describe('account avatar display', () => {
  it('shows a fixed-size fallback after image decoding fails and accepts a changed source', () => {
    const { container, rerender } = render(
      <AccountAvatar identity={identity} className="account-avatar" />,
    );
    fireEvent.error(screen.getByRole('img'));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container.querySelector('.account-avatar')).toHaveTextContent('L');
    rerender(
      <AccountAvatar
        identity={{ ...identity, avatarUrl: 'data:image/png;base64,AQ==' }}
        className="account-avatar"
      />,
    );
    expect(screen.getByRole('img')).toHaveAttribute('src', 'data:image/png;base64,AQ==');
    expect(screen.getByRole('img')).toHaveAttribute('referrerpolicy', 'no-referrer');
  });
});
