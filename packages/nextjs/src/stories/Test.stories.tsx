import type { Meta, StoryObj } from "@storybook/react";

const meta: Meta = {
	title: "Test/TailwindCSS",
	parameters: {
		layout: "padded",
	},
};

export default meta;
type Story = StoryObj<typeof meta>;

export const TailwindTest: Story = {
	render: () => (
		<div className="p-8 bg-background">
			<h1 className="text-4xl font-bold text-foreground mb-6">
				Tailwind CSS Test
			</h1>

			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
				<div className="p-6 bg-card border border-border rounded-lg shadow-sm">
					<h3 className="text-lg font-semibold text-card-foreground mb-2">
						Card 1
					</h3>
					<p className="text-muted-foreground">
						This card should have proper styling with Tailwind CSS.
					</p>
				</div>

				<div className="p-6 bg-primary text-primary-foreground rounded-lg">
					<h3 className="text-lg font-semibold mb-2">Primary Card</h3>
					<p>This card uses primary colors from the design system.</p>
				</div>

				<div className="p-6 bg-secondary text-secondary-foreground rounded-lg">
					<h3 className="text-lg font-semibold mb-2">Secondary Card</h3>
					<p>This card uses secondary colors from the design system.</p>
				</div>
			</div>

			<div className="mt-8 space-y-4">
				<button className="px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors">
					Primary Button
				</button>

				<button className="ml-4 px-4 py-2 bg-secondary text-secondary-foreground rounded hover:bg-secondary/80 transition-colors">
					Secondary Button
				</button>

				<button className="ml-4 px-4 py-2 bg-destructive text-destructive-foreground rounded hover:bg-destructive/90 transition-colors">
					Destructive Button
				</button>
			</div>

			<div className="mt-8 p-6 bg-muted rounded-lg">
				<h3 className="text-lg font-semibold text-foreground mb-2">
					Muted Section
				</h3>
				<p className="text-muted-foreground">
					This section uses muted colors and should be visible.
				</p>
			</div>
		</div>
	),
	parameters: {
		docs: {
			description: {
				story:
					"A simple test to verify that Tailwind CSS is working properly in Storybook.",
			},
		},
	},
};
