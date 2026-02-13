/**
 * Scrolls the element to the bottom only if it's already near the bottom.
 * @param element The scrollable element
 * @param threshold The distance from the bottom (in pixels) to consider "at the bottom"
 */
export function scrollToBottomIfAtBottom(
	element: HTMLElement,
	threshold: number = 50,
): void {
	const isAtBottom =
		element.scrollHeight - element.scrollTop <=
		element.clientHeight + threshold;
	if (isAtBottom) {
		element.scrollTop = element.scrollHeight;
	}
}
