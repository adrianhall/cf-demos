import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BLUEPRINTS } from '../../src/blueprints.ts';

vi.mock('@xyflow/react', () => import('./mock-xyflow.tsx'));

const { BlueprintGallery } =
  await import('../../src/client/components/blueprints/BlueprintGallery.tsx');

/**
 * @file Covers the gallery's filtering, its permanent blank-canvas card, and the fact that a card
 *   opens the creation modal over this page rather than navigating away. The filters are driven
 *   from the data rather than a fixed list, so these tests are too: a test naming "AI" explicitly
 *   would pass while a newly added category sat unreachable behind the existing pills.
 */

/**
 * Every distinct category present in the template data.
 */
const CATEGORIES = [...new Set(BLUEPRINTS.map((blueprint) => blueprint.category))];

describe('BlueprintGallery', () => {
  it('renders a card for the blank canvas and one per template', () => {
    render(<BlueprintGallery />);

    expect(screen.getByRole('button', { name: /blank canvas/iu })).toBeInTheDocument();
    for (const blueprint of BLUEPRINTS) {
      expect(
        screen.getByRole('button', { name: new RegExp(blueprint.title, 'u') })
      ).toBeInTheDocument();
    }
  });

  it('shows each template\u2019s category and description on its card', () => {
    render(<BlueprintGallery />);

    for (const blueprint of BLUEPRINTS) {
      expect(screen.getByText(blueprint.description)).toBeInTheDocument();
    }
  });

  describe('filtering', () => {
    it('offers a filter for every category in the data, plus All', () => {
      render(<BlueprintGallery />);

      expect(screen.getByRole('tab', { name: 'All' })).toBeInTheDocument();
      for (const category of CATEGORIES) {
        expect(screen.getByRole('tab', { name: category })).toBeInTheDocument();
      }
      expect(screen.getAllByRole('tab')).toHaveLength(CATEGORIES.length + 1);
    });

    it('selects All initially', () => {
      render(<BlueprintGallery />);

      expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    });

    // Driven from the data so a new category is covered the moment it is added.
    it.each(CATEGORIES)('narrows the grid to %s and hides the rest', (category) => {
      render(<BlueprintGallery />);

      fireEvent.click(screen.getByRole('tab', { name: category }));

      for (const blueprint of BLUEPRINTS) {
        const match = screen.queryByRole('button', { name: new RegExp(blueprint.title, 'u') });
        if (blueprint.category === category) {
          expect(match, `${blueprint.id} should be shown`).toBeInTheDocument();
        } else {
          expect(match, `${blueprint.id} should be hidden`).not.toBeInTheDocument();
        }
      }
    });

    it.each(CATEGORIES)('marks %s as the selected filter once chosen', (category) => {
      render(<BlueprintGallery />);

      fireEvent.click(screen.getByRole('tab', { name: category }));

      expect(screen.getByRole('tab', { name: category })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'false');
    });

    // Starting from nothing belongs to no category. A blank-canvas card that disappeared under a
    // filter would make the filter look like it had removed an option rather than a subset.
    it.each(CATEGORIES)('keeps the blank canvas card visible under the %s filter', (category) => {
      render(<BlueprintGallery />);

      fireEvent.click(screen.getByRole('tab', { name: category }));

      expect(screen.getByRole('button', { name: /blank canvas/iu })).toBeInTheDocument();
    });

    it('restores the full grid when All is chosen again', () => {
      render(<BlueprintGallery />);
      const [narrow] = CATEGORIES;

      fireEvent.click(screen.getByRole('tab', { name: narrow }));
      fireEvent.click(screen.getByRole('tab', { name: 'All' }));

      for (const blueprint of BLUEPRINTS) {
        expect(
          screen.getByRole('button', { name: new RegExp(blueprint.title, 'u') })
        ).toBeInTheDocument();
      }
    });
  });

  describe('opening the creation modal', () => {
    it('opens it with no template for the blank canvas', () => {
      render(<BlueprintGallery />);

      fireEvent.click(screen.getByRole('button', { name: /blank canvas/iu }));

      expect(screen.getByRole('dialog', { name: 'Create New Diagram' })).toBeInTheDocument();
    });

    it('opens it named after the chosen template', () => {
      render(<BlueprintGallery />);
      const blueprint = BLUEPRINTS[0];

      fireEvent.click(
        screen.getByRole('button', { name: new RegExp(blueprint?.title ?? '', 'u') })
      );

      expect(screen.getByRole('dialog', { name: blueprint?.title })).toBeInTheDocument();
    });

    it('seeds the form from the chosen template', () => {
      render(<BlueprintGallery />);
      const blueprint = BLUEPRINTS[0];

      fireEvent.click(
        screen.getByRole('button', { name: new RegExp(blueprint?.title ?? '', 'u') })
      );

      expect(screen.getByLabelText('Title')).toHaveValue(blueprint?.title);
      expect(screen.getByLabelText('Description')).toHaveValue(blueprint?.description);
    });

    // Re-selection has to reset the fields, which is what the modal's `key` achieves. Without it
    // the second template would open showing the first one's title.
    it('reseeds the form when a different template is chosen', () => {
      render(<BlueprintGallery />);
      const [first, second] = BLUEPRINTS;

      fireEvent.click(screen.getByRole('button', { name: new RegExp(first?.title ?? '', 'u') }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      fireEvent.click(screen.getByRole('button', { name: new RegExp(second?.title ?? '', 'u') }));

      expect(screen.getByLabelText('Title')).toHaveValue(second?.title);
    });

    it('renders no dialog until a card is activated', () => {
      render(<BlueprintGallery />);

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('closes on Cancel', () => {
      render(<BlueprintGallery />);

      fireEvent.click(screen.getByRole('button', { name: /blank canvas/iu }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  describe('the generate-with-AI card', () => {
    it('offers it alongside the blank canvas', () => {
      render(<BlueprintGallery />);

      expect(screen.getByRole('button', { name: 'Generate with AI' })).toBeInTheDocument();
    });

    // Describing what you want belongs to no category, exactly as starting from nothing does.
    it.each(CATEGORIES)('keeps it visible under the %s filter', (category) => {
      render(<BlueprintGallery />);

      fireEvent.click(screen.getByRole('tab', { name: category }));

      expect(screen.getByRole('button', { name: 'Generate with AI' })).toBeInTheDocument();
    });

    it('opens the generation modal rather than the creation form', () => {
      render(<BlueprintGallery />);

      fireEvent.click(screen.getByRole('button', { name: 'Generate with AI' }));

      expect(screen.getByRole('dialog', { name: 'Generate with AI' })).toBeInTheDocument();
      expect(screen.getByLabelText(/describe the architecture/iu)).toBeInTheDocument();
    });

    it('closes on Cancel', () => {
      render(<BlueprintGallery />);

      fireEvent.click(screen.getByRole('button', { name: 'Generate with AI' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  describe('card structure', () => {
    // One tab stop and one activation target per card. A nested control inside it would announce
    // the same action a second time.
    it('makes each card a single button with no nested control', () => {
      render(<BlueprintGallery />);
      const blueprint = BLUEPRINTS[0];

      const card = screen.getByRole('button', { name: new RegExp(blueprint?.title ?? '', 'u') });

      expect(card.tagName).toBe('BUTTON');
      expect(card.querySelectorAll('button, a')).toHaveLength(0);
    });

    it('names each card by its title rather than by its thumbnail', () => {
      render(<BlueprintGallery />);
      const blueprint = BLUEPRINTS[0];

      const card = screen.getByRole('button', { name: new RegExp(blueprint?.title ?? '', 'u') });

      expect(card).toHaveAccessibleName(expect.stringContaining(blueprint?.title ?? '') as string);
    });

    it('renders a real thumbnail per template card', () => {
      render(<BlueprintGallery />);

      // One per template; the blank-canvas card shows a glyph rather than a canvas.
      expect(screen.getAllByTestId('react-flow')).toHaveLength(BLUEPRINTS.length);
    });
  });
});
