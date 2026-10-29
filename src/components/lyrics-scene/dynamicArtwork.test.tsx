import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DynamicArtworkBackdrop } from './DynamicArtworkBackdrop';
import {
  LANDSCAPE_CONTROL_POINTS,
  PORTRAIT_CONTROL_POINTS,
  createControlGrids,
} from './dynamicArtworkMesh';

describe('dynamic artwork backdrop', () => {
  it('never folds: control points stay ordered along rows and columns in both poses', () => {
    for (const size of [PORTRAIT_CONTROL_POINTS, LANDSCAPE_CONTROL_POINTS]) {
      for (let seed = 0; seed < 200; seed += 1) {
        const { from, to } = createControlGrids(size, seed);
        for (const grid of [from, to]) {
          for (let row = 0; row < size; row += 1) {
            for (let column = 1; column < size; column += 1) {
              expect(grid[row]![column]![0]).toBeGreaterThan(grid[row]![column - 1]![0]);
              expect(grid[column]![row]![1]).toBeGreaterThan(grid[column - 1]![row]![1]);
            }
          }
        }
      }
    }
  });

  it('reports unavailability when WebGL2 is missing so the scene can use the static backdrop', () => {
    const onUnavailable = vi.fn();
    render(
      <DynamicArtworkBackdrop
        source="data:image/png;base64,"
        animating
        opacity={1}
        selected={false}
        onUnavailable={onUnavailable}
      />,
    );
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });
});
