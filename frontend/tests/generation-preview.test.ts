import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import GenerationPreview from '../src/components/GenerationPreview.vue';
import { api } from '../src/api/client';
import type { GenerationJob } from '../src/api/types';

vi.mock('../src/api/client', () => ({ api: vi.fn() }));
const apiMock = vi.mocked(api);
let wrapper: VueWrapper | undefined;
let current: GenerationJob;
let pdfError = false;
const makeJob = (status: GenerationJob['status']): GenerationJob => ({
  id: 'job',
  templateId: 'letter',
  templateName: 'Letter',
  status,
  timestamp: '2026-11-13T00:00:00Z',
  message:
    status === 'failed'
      ? 'Could not generate PDF. Check the template or contact the administrator.'
      : 'PDF generated',
  pdfFilename: status === 'ok' ? 'result.pdf' : null,
});
beforeEach(() => {
  vi.useFakeTimers();
  current = makeJob('queued');
  pdfError = false;
  vi.stubGlobal('navigator', { pdfViewerEnabled: true });
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:preview');
      static revokeObjectURL = vi.fn();
    },
  );
  apiMock.mockReset();
  apiMock.mockImplementation(async (path) => {
    if (path.endsWith('/pdf')) {
      if (pdfError) throw new Error('PDF preview unavailable');
      return new Blob(['%PDF'], { type: 'application/pdf' });
    }
    return { job: current };
  });
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function open(job: GenerationJob | null = null) {
  wrapper = mount(GenerationPreview, {
    props: { job, showPreview: true, submitting: false, error: '' },
  });
  await flushPromises();
}
const bar = () => wrapper!.get('[aria-label="Generation status"]');
it('starts with a neutral Ready bar, no information, and a disabled icon download', async () => {
  await open();
  expect(
    wrapper!
      .get('[aria-label="Document preview"]')
      .find('[aria-label="Generation status"]')
      .exists(),
  ).toBe(true);
  expect(bar().attributes('data-state')).toBe('ready');
  expect(bar().text()).toBe('Ready');
  expect(wrapper!.find('.fa-info').exists()).toBe(false);
  expect(
    wrapper!.get('button[aria-label="Download PDF"]').attributes('disabled'),
  ).toBeDefined();
  expect(wrapper!.find('.fa-download').exists()).toBe(true);
  expect(apiMock).not.toHaveBeenCalled();
});
it('shows Generating with the daisyUI spinner during submission and queued/generating polls', async () => {
  await open();
  await wrapper!.setProps({ submitting: true });
  expect(bar().text()).toContain('Generating...');
  expect(bar().find('.loading.loading-spinner').exists()).toBe(true);
  wrapper!.unmount();
  wrapper = undefined;
  await open(current);
  expect(bar().attributes('data-state')).toBe('generating');
  current = makeJob('generating');
  await vi.advanceTimersByTimeAsync(2000);
  await flushPromises();
  expect(bar().find('.loading-spinner').exists()).toBe(true);
});
it('shows a green Generated bar, timestamp information, icon download, and only the PDF viewer below', async () => {
  current = makeJob('ok');
  await open(current);
  expect(bar().attributes('data-state')).toBe('generated');
  expect(bar().find('.fa-check').exists()).toBe(true);
  expect(bar().get('a[aria-label="Download PDF"]').attributes('href')).toBe(
    '/api/jobs/job/pdf',
  );
  const info = bar().get('button[aria-label="Generation information"]');
  await info.trigger('focus');
  expect(bar().get('[role=tooltip]').isVisible()).toBe(true);
  expect(bar().get('[role=tooltip]').text()).toContain(
    'Generation succeeded for document submitted at',
  );
  expect(bar().get('[role=tooltip]').text()).toContain(
    new Date(current.timestamp).toLocaleString(),
  );
  await info.trigger('keydown', { key: 'Escape' });
  expect(info.attributes('aria-expanded')).toBe('false');
  expect(bar().get('[role=tooltip]').attributes('style')).toContain(
    'display: none',
  );
  expect(wrapper!.get('iframe').attributes('src')).toBe('blob:preview');
  expect(wrapper!.text()).not.toContain('Submitted ');
});
it('keeps hover details open while crossing the toolbar and closes them when leaving it', async () => {
  current = makeJob('ok');
  await open(current);
  const info = bar().get('button[aria-label="Generation information"]');
  await info.trigger('mouseenter');
  await bar().get('span.inline-flex').trigger('mouseleave');
  expect(info.attributes('aria-expanded')).toBe('true');
  await bar().trigger('mouseleave');
  expect(info.attributes('aria-expanded')).toBe('false');
});

it('shows red Error with the failure information and no enabled download', async () => {
  current = makeJob('failed');
  await open(current);
  expect(bar().attributes('data-state')).toBe('error');
  expect(bar().find('.fa-x').exists()).toBe(true);
  await bar()
    .get('button[aria-label="Generation information"]')
    .trigger('click');
  expect(bar().get('[role=tooltip]').text()).toBe(current.message);
  expect(wrapper!.find('a[aria-label="Download PDF"]').exists()).toBe(false);
});
it('reports submission errors in the bar without requesting a job', async () => {
  await open();
  await wrapper!.setProps({ error: 'Choose a file for logo.' });
  expect(bar().attributes('data-state')).toBe('error');
  expect(bar().get('[role=tooltip]').text()).toBe('Choose a file for logo.');
  expect(apiMock).not.toHaveBeenCalled();
});
it('allows retry after polling fails and stops polling after completion', async () => {
  apiMock.mockRejectedValueOnce(new Error('Status unavailable'));
  await open(current);
  expect(bar().attributes('data-state')).toBe('error');
  current = makeJob('ok');
  await bar().get('button[aria-label="Retry status"]').trigger('click');
  await flushPromises();
  expect(bar().attributes('data-state')).toBe('generated');
  const count = apiMock.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(apiMock).toHaveBeenCalledTimes(count);
});
it('shows PDF load failures in the bar and can retry the preview', async () => {
  current = makeJob('ok');
  pdfError = true;
  await open(current);
  expect(bar().attributes('data-state')).toBe('error');
  expect(bar().get('[role=tooltip]').text()).toContain(
    'PDF preview unavailable',
  );
  pdfError = false;
  await bar().get('button[aria-label="Retry preview"]').trigger('click');
  await flushPromises();
  expect(wrapper!.find('iframe').exists()).toBe(true);
  expect(bar().attributes('data-state')).toBe('generated');
});
it('keeps Generated and download available when the browser cannot embed PDFs', async () => {
  vi.stubGlobal('navigator', { pdfViewerEnabled: false });
  current = makeJob('ok');
  await open(current);
  expect(bar().attributes('data-state')).toBe('generated');
  expect(bar().get('[role=tooltip]').text()).toContain(
    'browser does not support PDF preview',
  );
  expect(wrapper!.find('iframe').exists()).toBe(false);
  expect(wrapper!.find('a[aria-label="Download PDF"]').exists()).toBe(true);
});
it('does not restart polling when an in-flight response finishes after unmount', async () => {
  let complete!: (value: unknown) => void;
  apiMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await open(current);
  wrapper!.unmount();
  wrapper = undefined;
  complete({ job: current });
  await flushPromises();
  expect(vi.getTimerCount()).toBe(0);
});
