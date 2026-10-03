import React from "react";

// Mock Button component
export const Button: React.FC<
	React.ButtonHTMLAttributes<HTMLButtonElement> & {
		variant?: string;
		size?: string;
		asChild?: boolean;
	}
> = ({
	children,
	variant = "default",
	size = "default",
	asChild = false,
	className = "",
	...props
}) => {
	const baseClasses =
		"inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none ring-offset-background";

	const variantClasses = {
		default: "bg-primary text-primary-foreground hover:bg-primary/90",
		destructive:
			"bg-destructive text-destructive-foreground hover:bg-destructive/90",
		outline: "border border-input hover:bg-accent hover:text-accent-foreground",
		secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
		ghost: "hover:bg-accent hover:text-accent-foreground",
		link: "underline-offset-4 hover:underline text-primary",
	};

	const sizeClasses = {
		default: "h-10 py-2 px-4",
		sm: "h-9 px-3 rounded-md",
		lg: "h-11 px-8 rounded-md",
		icon: "h-10 w-10",
	};

	const classes = `${baseClasses} ${variantClasses[variant as keyof typeof variantClasses] || variantClasses.default} ${sizeClasses[size as keyof typeof sizeClasses] || sizeClasses.default} ${className}`;

	if (asChild && React.isValidElement(children)) {
		return React.cloneElement(children, { className: classes, ...props });
	}

	return (
		<button className={classes} {...props}>
			{children}
		</button>
	);
};

// Mock FileUpload components
export const FileUpload: React.FC<{
	children: React.ReactNode;
	value?: File[];
	onValueChange?: (files: File[]) => void;
	maxFiles?: number;
}> = ({ children, value, onValueChange, maxFiles }) => {
	return <div className="file-upload">{children}</div>;
};

export const FileUploadDropzone: React.FC<{
	children: React.ReactNode;
	className?: string;
}> = ({ children, className = "" }) => {
	return <div className={`file-upload-dropzone ${className}`}>{children}</div>;
};

export const FileUploadTrigger: React.FC<{
	children: React.ReactNode;
	asChild?: boolean;
}> = ({ children, asChild = false }) => {
	if (asChild && React.isValidElement(children)) {
		return React.cloneElement(children, {
			onClick: () => {
				const input = document.createElement("input");
				input.type = "file";
				input.multiple = true;
				input.accept = "*/*";
				input.onchange = (e) => {
					const target = e.target as HTMLInputElement;
					if (target.files) {
						// Trigger the onValueChange if available
						const event = new CustomEvent("fileUploadChange", {
							detail: { files: Array.from(target.files) },
						});
						window.dispatchEvent(event);
					}
				};
				input.click();
			},
		});
	}
	return <>{children}</>;
};

export const FileUploadList: React.FC<{
	children: React.ReactNode;
	className?: string;
}> = ({ children, className = "" }) => {
	return <div className={`file-upload-list ${className}`}>{children}</div>;
};

export const FileUploadItem: React.FC<{
	children: React.ReactNode;
	value?: File;
	className?: string;
}> = ({ children, className = "" }) => {
	return <div className={`file-upload-item ${className}`}>{children}</div>;
};

export const FileUploadItemPreview: React.FC<{
	children: React.ReactNode;
	className?: string;
}> = ({ children, className = "" }) => {
	return (
		<div className={`file-upload-item-preview ${className}`}>{children}</div>
	);
};

export const FileUploadItemMetadata: React.FC<{
	children: React.ReactNode;
	className?: string;
}> = ({ children, className = "" }) => {
	return (
		<div className={`file-upload-item-metadata ${className}`}>{children}</div>
	);
};

export const FileUploadItemDelete: React.FC<{
	children: React.ReactNode;
	asChild?: boolean;
}> = ({ children, asChild = false }) => {
	if (asChild && React.isValidElement(children)) {
		return React.cloneElement(children, {
			onClick: (e: React.MouseEvent) => {
				e.preventDefault();
				e.stopPropagation();
				// Trigger delete event
				const event = new CustomEvent("fileUploadDelete", {
					detail: {
						fileId: (e.currentTarget as HTMLElement)
							.closest(".file-upload-item")
							?.getAttribute("data-file-id"),
					},
				});
				window.dispatchEvent(event);
			},
		});
	}
	return <>{children}</>;
};
