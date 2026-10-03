import { withThemeByDataAttribute } from "@storybook/addon-themes";
import type { Preview } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import "../src/styles/globals.css"; // This will make Tailwind's style classes available to all stories

// Create a new QueryClient for each story
const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			retry: false,
			refetchOnWindowFocus: false,
		},
	},
});

const preview: Preview = {
	parameters: {
		controls: {
			matchers: {
				color: /(background|color)$/i,
				date: /Date$/,
			},
		},
		backgrounds: {
			default: "light",
			values: [
				{
					name: "light",
					value: "#ffffff",
				},
				{
					name: "dark",
					value: "#0f0f23",
				},
			],
		},
	},
	decorators: [
		withThemeByDataAttribute({
			themes: {
				light: "light",
				dark: "dark",
			},
			defaultTheme: "light",
			attributeName: "data-mode",
		}),
		(Story) => (
			<QueryClientProvider client={queryClient}>
				<div className="p-6 font-sans">
					<Story />
				</div>
			</QueryClientProvider>
		),
	],
};

export default preview;
